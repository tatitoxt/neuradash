import { z } from "zod";

export const MAX_BATCH = 100;
export const MAX_PROPERTIES_BYTES = 2048;
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_PAST_MS = 7 * 24 * 60 * 60_000;

const eventSchema = z
  .object({
    type: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/i, "type must be 1-64 chars of [a-z0-9_.:-]"),
    source: z.string().trim().min(1).max(128).default("api"),
    value: z.number().finite().nullable().optional(),
    properties: z
      .record(z.string(), z.unknown())
      .default({})
      .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PROPERTIES_BYTES, {
        message: `properties must serialize to <= ${MAX_PROPERTIES_BYTES} bytes`,
      }),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const ingestBodySchema = z.union([
  eventSchema.transform((e) => [e]),
  z.object({ events: z.array(eventSchema).min(1).max(MAX_BATCH) }).strict().transform((b) => b.events),
]);

export type IngestEvent = {
  type: string;
  source: string;
  value: number | null;
  properties: Record<string, unknown>;
  occurredAt: Date;
};

export type ParseResult = { ok: true; events: IngestEvent[] } | { ok: false; error: string };

/** Validates an ingest body. Note: there is no tenant field — the tenant comes from the API key. */
export function parseIngestBody(body: unknown, now = Date.now()): ParseResult {
  const parsed = ingestBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body" };
  }
  const events: IngestEvent[] = [];
  for (const e of parsed.data) {
    const occurredAt = e.occurredAt ? new Date(e.occurredAt) : new Date(now);
    if (occurredAt.getTime() > now + MAX_FUTURE_MS || occurredAt.getTime() < now - MAX_PAST_MS) {
      return { ok: false, error: "occurredAt must be within the last 7 days and not in the future" };
    }
    events.push({ type: e.type, source: e.source, value: e.value ?? null, properties: e.properties, occurredAt });
  }
  return { ok: true, events };
}
