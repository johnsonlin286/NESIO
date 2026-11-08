import { generateUserId } from "../lib/ids.js";
import { signSessionToken, verifySessionToken } from "./session-token.js";
import type { Authenticator } from "./types.js";

/**
 * Mode guest: tidak perlu login.
 * - Koneksi pertama: server membuat userId baru + sessionToken.
 * - Koneksi berikutnya: client mengirim `auth.sessionToken` -> userId sama.
 */
export function createGuestAuthenticator(secret: string): Authenticator {
  return async ({ auth }) => {
    const restoredUserId = auth.sessionToken ? verifySessionToken(auth.sessionToken, secret) : null;
    const userId = restoredUserId ?? generateUserId();

    return {
      identity: {
        userId,
        name: auth.name ?? `Guest-${userId.slice(0, 4).toUpperCase()}`,
        avatar: auth.avatar ?? null,
      },
      sessionToken: signSessionToken(userId, secret),
    };
  };
}
