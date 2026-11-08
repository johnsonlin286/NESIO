import type { Authenticator } from "../auth/types.js";
import type { RoomStore } from "../core/store/room-store.js";
import { AppError } from "../lib/errors.js";
import type { AppServer, AppSocket } from "../socket/types.js";

/**
 * Aturan nama pemain ABC Words (juga dicek di client):
 * 3–20 karakter, hanya huruf ASCII, angka, underscore dan dash.
 * Whitelist ini membuat nama aman dipakai di mana pun (HTML, log, URL).
 */
export const PLAYER_NAME_MIN = 3;
export const PLAYER_NAME_MAX = 20;
export const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** connect_error yang diterima client. */
export const INVALID_NAME = "INVALID_NAME";
export const NAME_TAKEN = "NAME_TAKEN";

/** Klaim singkat untuk menutup race dua handshake bersamaan dengan nama yang sama. */
const HANDSHAKE_CLAIM_MS = 5_000;

export function isValidPlayerName(name: string): boolean {
  return name.length >= PLAYER_NAME_MIN && name.length <= PLAYER_NAME_MAX && PLAYER_NAME_PATTERN.test(name);
}

export interface PlayerNameGuardOptions {
  /** Authenticator asli (guest / JWT) yang menentukan userId. */
  base: Authenticator;
  store: RoomStore;
  /** Lazy, karena `io` baru ada setelah createRoomServer() selesai. */
  io: () => AppServer;
  now?: () => number;
}

export interface PlayerNameGuard {
  authenticate: Authenticator;
  /** Pasang listener koneksi: lepas klaim handshake & buang `displayName` override. */
  attach(io: AppServer): void;
}

/**
 * Membungkus authenticator: koneksi ditolak kalau nama tidak valid atau
 * sedang dipakai user lain. "Dipakai" = ada koneksi aktif dengan nama itu,
 * atau user itu masih tercatat di room (termasuk masa tunggu reconnect).
 * User yang sama (sessionToken valid) selalu boleh memakai namanya lagi.
 */
export function createPlayerNameGuard({ base, store, io, now = Date.now }: PlayerNameGuardOptions): PlayerNameGuard {
  // Menutup jeda antara handshake lolos dan socket terdaftar di io (dua handshake bersamaan).
  const claims = new Map<string, { userId: string; until: number }>();

  async function holderOf(key: string): Promise<string | null> {
    for (const socket of io().of("/").sockets.values()) {
      const identity = socket.data.identity;
      if (identity && identity.name.toLowerCase() === key) return identity.userId;
    }
    for (const room of await store.list()) {
      const member = room.members.find((m) => m.name.toLowerCase() === key);
      if (member) return member.userId;
    }
    const claim = claims.get(key);
    if (claim && claim.until > now()) return claim.userId;
    return null;
  }

  const authenticate: Authenticator = async (input) => {
    const name = input.auth.name;
    // Mode guest tanpa nama akan memberi nama "Guest-XXXX"; ABC Words mewajibkan nama sendiri.
    if (!name || !isValidPlayerName(name)) throw new AppError(INVALID_NAME, "Nama tidak valid");

    const result = await base(input);
    const key = name.toLowerCase();
    const holder = await holderOf(key);
    if (holder && holder !== result.identity.userId) throw new AppError(NAME_TAKEN, "Nama sudah dipakai");

    claims.set(key, {
      userId: result.identity.userId,
      until: now() + HANDSHAKE_CLAIM_MS,
    });
    for (const [k, claim] of claims) if (claim.until <= now()) claims.delete(k);

    return { ...result, identity: { ...result.identity, name } };
  };

  const attach = (server: AppServer) => {
    server.on("connection", (socket) => {
      // Sekarang socket sudah terlihat di io, klaim sementara tidak diperlukan lagi.
      claims.delete(socket.data.identity.name.toLowerCase());
      stripNameOverrides(socket);
    });
  };

  return { authenticate, attach };
}

/**
 * `room:create` / `room:join` menerima `displayName` yang mengganti nama per room.
 * ABC Words tidak memakainya, dan field itu bisa dipakai untuk melewati aturan nama,
 * jadi dibuang sebelum sampai ke handler core.
 */
function stripNameOverrides(socket: AppSocket): void {
  socket.use(([event, payload], next) => {
    if ((event === "room:create" || event === "room:join") && payload && typeof payload === "object") {
      delete (payload as { displayName?: unknown }).displayName;
    }
    next();
  });
}
