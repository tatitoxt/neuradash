import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 256-bit random session token (base64url). Only its SHA-256 is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export const API_KEY_PREFIX = "nd_";

/** API key shown to the admin once: `nd_<40 hex chars>`. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(20).toString("hex");
}

/** Short, non-secret identifier displayed in the admin UI. */
export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + 6);
}
