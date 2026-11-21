import type { Authenticator } from "../../auth/types.js";
import { AppError, Errors } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { ACCOUNT_NAME_CLAIM, INVALID_NAME, NAME_TAKEN } from "../player-names.js";
import type { AuthService } from "./service.js";

/**
 * Handshake Socket.IO untuk dua jenis pemain sekaligus:
 * - web (tanpa `auth.token`): guest seperti biasa;
 * - aplikasi Android (`auth.token` = access token kita): akun harus masih ada.
 * Nama: akun aplikasi selalu memakai `displayName`-nya (wajib sudah dipilih); tamu memakai nama
 * di handshake, asal bukan nama milik akun.
 */
export function createAppAuthenticator(
  guest: Authenticator,
  service: AuthService | null,
  logger?: Logger,
): Authenticator {
  return async (input) => {
    const { token, name } = input.auth;
    if (!token) {
      if (service && name && (await reservedByAccount(service, name, logger))) {
        throw new AppError(NAME_TAKEN, "Nama sudah dipakai");
      }
      return guest(input);
    }
    if (!service) throw Errors.unauthorized("Login aplikasi belum aktif di server ini");

    const user = await service.getUser(await service.verifyAccessToken(token));
    if (!user) throw Errors.unauthorized("Akun tidak ditemukan");
    // Aplikasi meminta nama sebelum main; tanpa nama milik akun, pemain bisa meniru nama orang lain.
    if (!user.displayName) throw new AppError(INVALID_NAME, "Pilih nama pemain dulu");

    return {
      identity: {
        userId: user.id,
        name: user.displayName,
        avatar: input.auth.avatar ?? null,
        claims: { [ACCOUNT_NAME_CLAIM]: user.displayName },
      },
      sessionToken: null,
    };
  };
}

/**
 * Gagal terbuka: kalau database sedang bermasalah, tamu web tetap bisa main (risikonya hanya nama
 * akun bisa dipakai sementara), daripada seluruh web ikut mati.
 */
async function reservedByAccount(service: AuthService, name: string, logger?: Logger): Promise<boolean> {
  try {
    return (await service.findUserIdByName(name)) !== null;
  } catch (error) {
    logger?.warn({ err: error }, "reserved name check failed, allowing guest");
    return false;
  }
}
