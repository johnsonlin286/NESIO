import type { Authenticator } from "../auth/types.js";
import { parseHandshakeAuth } from "../auth/handshake.js";
import type { AppConfig } from "../config/env.js";
import type { PresenceTracker } from "../core/presence.js";
import type { RoomService } from "../core/room-service.js";
import { AppError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { FailedAttemptLimiter } from "../lib/attempt-limiter.js";
import { FixedWindowLimiter } from "../lib/rate-limiter.js";
import { buildSession, registerRoomHandlers } from "./handlers.js";
import { roomChannel, userChannel, type AppServer } from "./types.js";

export interface SocketLayerDeps {
  io: AppServer;
  config: AppConfig;
  rooms: RoomService;
  presence: PresenceTracker;
  authenticator: Authenticator;
  logger: Logger;
}

export function setupSocketLayer({ io, config, rooms, presence, authenticator, logger }: SocketLayerDeps): void {
  const log = logger.child({ component: "socket" });
  // 5 password salah dalam 1 menit -> room itu terkunci 1 menit untuk alamat IP tersebut.
  const passwordAttempts = new FailedAttemptLimiter(5, 60_000, 60_000);

  // 1. Autentikasi saat handshake. Gagal -> client menerima `connect_error`.
  io.use(async (socket, next) => {
    try {
      const result = await authenticator({
        auth: parseHandshakeAuth(socket.handshake.auth),
        headers: socket.handshake.headers,
        ip: socket.handshake.address,
      });
      socket.data.identity = result.identity;
      socket.data.sessionToken = result.sessionToken;
      next();
    } catch (error) {
      const message = error instanceof AppError ? error.code : "UNAUTHORIZED";
      if (!(error instanceof AppError)) log.warn({ err: error }, "authentication failed");
      next(new Error(message));
    }
  });

  // 2. Koneksi baru.
  io.on("connection", (socket) => {
    const { userId } = socket.data.identity;
    const socketLog = log.child({ socketId: socket.id, userId });

    // Semua koneksi milik user yang sama masuk ke channel user:<id>,
    // sehingga server bisa kirim ke "user" bukan ke socket tertentu.
    void socket.join(userChannel(userId));

    // Daftarkan handler secara sinkron dulu supaya event awal dari client tidak hilang.
    registerRoomHandlers(socket, {
      rooms,
      presence,
      limiter: new FixedWindowLimiter(config.socket.rateLimit.max, config.socket.rateLimit.windowMs),
      passwordAttempts,
      ip: socket.handshake.address,
      logger: socketLog,
    });

    socket.on("disconnect", (reason) => {
      socketLog.debug({ reason }, "socket disconnected");
      presence.disconnected(userId).catch((error: unknown) => {
        socketLog.error({ err: error }, "failed to handle disconnect");
      });
    });

    socketLog.debug({ recovered: socket.recovered }, "socket connected");

    // Pulihkan room (kalau user sedang di room) lalu kirim info sesi.
    void (async () => {
      try {
        const presenceResult = await presence.connected(userId);
        if (socket.disconnected) return;
        if (presenceResult) await socket.join(roomChannel(presenceResult.roomId));

        socket.emit("session", buildSession(socket, presenceResult?.roomId ?? null));
        if (presenceResult) {
          const view = await rooms.getViewForUser(userId);
          if (view) socket.emit("room:state", view);
        }
      } catch (error) {
        socketLog.error({ err: error }, "failed to restore session");
      }
    })();
  });
}
