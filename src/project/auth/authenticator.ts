import type { Authenticator } from "../../auth/types.js";
import { Errors } from "../../lib/errors.js";
import type { AuthService } from "./service.js";

/**
 * Handshake Socket.IO untuk dua jenis pemain sekaligus:
 * - web (tanpa `auth.token`): guest seperti biasa;
 * - aplikasi Android (`auth.token` = access token kita): akun harus masih ada.
 * Nama: `displayName` akun kalau sudah diisi, selain itu nama dari handshake.
 */
export function createAppAuthenticator(guest: Authenticator, service: AuthService | null): Authenticator {
  return async (input) => {
    const { token } = input.auth;
    if (!token) return guest(input);
    if (!service) throw Errors.unauthorized("Login aplikasi belum aktif di server ini");

    const user = await service.getUser(await service.verifyAccessToken(token));
    if (!user) throw Errors.unauthorized("Akun tidak ditemukan");

    return {
      identity: {
        userId: user.id,
        name: user.displayName ?? input.auth.name ?? `Pemain-${user.id.slice(0, 4)}`,
        avatar: input.auth.avatar ?? null,
      },
      sessionToken: null,
    };
  };
}
