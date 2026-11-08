import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

/**
 * Token sesi guest: `v1.<userId>.<hmac>`.
 * Stateless (tidak perlu database) dan tidak bisa dipalsukan tanpa SESSION_SECRET.
 */
export function signSessionToken(userId: string, secret: string): string {
  return `${VERSION}.${userId}.${sign(userId, secret)}`;
}

/** Mengembalikan userId jika token valid, selain itu `null`. */
export function verifySessionToken(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, userId, signature] = parts as [string, string, string];
  if (version !== VERSION || !userId) return null;

  const expected = Buffer.from(sign(userId, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? userId : null;
}

function sign(userId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${VERSION}:${userId}`).digest("base64url");
}
