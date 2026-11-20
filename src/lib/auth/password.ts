import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LENGTH = 32;
/** OWASP-recommended scrypt parameters: N=2^17, r=8, p=1 (~128 MiB). */
export const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;

type Params = { N: number; r: number; p: number };

function scrypt(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r };
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns a self-describing hash: `scrypt$N$r$p$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string, params: Params = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}
