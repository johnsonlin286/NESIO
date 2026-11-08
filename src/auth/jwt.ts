import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { Errors } from "../lib/errors.js";
import { cleanText } from "../lib/text.js";
import type { Authenticator } from "./types.js";

export interface JwtAuthOptions {
  /** Shared secret HS256 (mis. token yang Anda buat sendiri di backend Next.js). */
  secret?: string;
  /** JWKS URL untuk provider seperti Firebase, Supabase, Auth0, Clerk, Cognito. */
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
}

/**
 * Mode JWT: client wajib mengirim `auth.token`.
 * - `sub` -> userId
 * - `name` / `preferred_username` / `email` -> nama tampilan
 * - `picture` -> avatar
 * Semua claim disimpan di `identity.claims` (tidak dikirim ke client lain).
 */
export function createJwtAuthenticator(options: JwtAuthOptions): Authenticator {
  const key: Uint8Array | JWTVerifyGetKey = options.jwksUrl
    ? createRemoteJWKSet(new URL(options.jwksUrl))
    : new TextEncoder().encode(options.secret ?? "");

  if (!options.jwksUrl && !options.secret) throw new Error("JWT auth butuh secret atau jwksUrl");

  return async ({ auth }) => {
    if (!auth.token) throw Errors.unauthorized("Token wajib dikirim");

    let payload: JWTPayload;
    try {
      const verifyOptions = {
        ...(options.issuer && { issuer: options.issuer }),
        ...(options.audience && { audience: options.audience }),
      };
      ({ payload } =
        key instanceof Uint8Array
          ? await jwtVerify(auth.token, key, { ...verifyOptions, algorithms: ["HS256", "HS384", "HS512"] })
          : await jwtVerify(auth.token, key, verifyOptions));
    } catch {
      throw Errors.unauthorized("Token tidak valid atau kedaluwarsa");
    }

    if (!payload.sub) throw Errors.unauthorized("Token tidak memiliki claim 'sub'");

    const rawName = auth.name ?? firstString(payload["name"], payload["preferred_username"], payload["email"]);
    const name = rawName ? cleanText(rawName).slice(0, 32) : "";

    return {
      identity: {
        userId: payload.sub,
        name: name || `User-${payload.sub.slice(0, 4)}`,
        avatar: auth.avatar ?? firstString(payload["picture"]) ?? null,
        claims: payload as Record<string, unknown>,
      },
      sessionToken: null,
    };
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
