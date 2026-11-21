import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { Errors } from "../../lib/errors.js";

export const ACCESS_TOKEN_ISSUER = "abc-words";
export const ACCESS_TOKEN_AUDIENCE = "abc-words-app";

export function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Access token: JWT HS256 berumur pendek, `sub` = id user. Tidak disimpan di server. */
export async function signAccessToken(userId: string, key: Uint8Array, ttlSec: number, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSec)
    .sign(key);
  return { token, expiresAt: (issuedAt + ttlSec) * 1000 };
}

/** Mengembalikan id user dari access token yang valid; selain itu UNAUTHORIZED. */
export async function verifyAccessToken(token: string, key: Uint8Array): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: ["HS256"],
    });
    if (!payload.sub) throw new Error("missing sub");
    return payload.sub;
  } catch {
    throw Errors.unauthorized("Sesi tidak valid atau kedaluwarsa");
  }
}

/** Refresh token: 256 bit acak. Yang masuk database hanya hash-nya. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
