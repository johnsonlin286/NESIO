import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { Errors } from "../../lib/errors.js";

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface GoogleProfile {
  /** ID akun Google yang tetap (claim `sub`). */
  sub: string;
  email: string | null;
}

/** Memverifikasi ID token dari Google Sign-In; lempar UNAUTHORIZED kalau tidak valid. */
export type GoogleVerifier = (idToken: string) => Promise<GoogleProfile>;

/**
 * Verifikasi lokal dengan kunci publik Google (JWKS, di-cache oleh jose): tanda tangan RS256,
 * issuer Google, `aud` salah satu client ID kita, dan belum kedaluwarsa. Tidak perlu memanggil
 * endpoint tokeninfo Google untuk setiap login.
 */
export function createGoogleVerifier(
  audiences: string[],
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_CERTS_URL)),
): GoogleVerifier {
  return async (idToken) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: GOOGLE_ISSUERS,
        audience: audiences,
        algorithms: ["RS256"],
      }));
    } catch {
      throw Errors.unauthorized("Login Google tidak valid atau kedaluwarsa");
    }
    if (!payload.sub) throw Errors.unauthorized("Login Google tidak valid");
    const verified = payload["email_verified"] === true;
    const email = typeof payload["email"] === "string" && verified ? payload["email"] : null;
    return { sub: payload.sub, email };
  };
}
