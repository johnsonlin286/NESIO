import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { Server } from "socket.io";
import { createAuthenticatorFromConfig, type Authenticator } from "./auth/index.js";
import type { AppConfig } from "./config/env.js";
import { ModuleRegistry, type AnyRoomModule } from "./core/module.js";
import { PresenceTracker } from "./core/presence.js";
import { RoomService } from "./core/room-service.js";
import { MemoryRoomStore } from "./core/store/memory-room-store.js";
import type { RoomStore } from "./core/store/room-store.js";
import { createCorsOptions, createHttpApp } from "./http/app.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { setupSocketLayer } from "./socket/index.js";
import { SocketNotifier } from "./socket/socket-notifier.js";
import type { AppServer } from "./socket/types.js";

export interface CreateRoomServerOptions {
  config: AppConfig;
  /** Logic spesifik project. Module pertama menjadi tipe room default. */
  modules: AnyRoomModule[];
  logger?: Logger;
  /** Default: MemoryRoomStore. */
  store?: RoomStore;
  /** Default: dari AUTH_MODE (guest / jwt). */
  authenticator?: Authenticator;
  /** Tambahan route Express khusus project. */
  registerRoutes?: (app: Express) => void;
}

export interface RoomServer {
  app: Express;
  httpServer: HttpServer;
  io: AppServer;
  rooms: RoomService;
  logger: Logger;
  /** Mulai listen. Mengembalikan port sebenarnya (berguna saat PORT=0 di test). */
  start(): Promise<number>;
  stop(): Promise<void>;
}

export function createRoomServer(options: CreateRoomServerOptions): RoomServer {
  const { config } = options;
  const logger = options.logger ?? createLogger(config);

  const httpServer = createServer();
  const io: AppServer = new Server(httpServer, {
    cors: createCorsOptions(config),
    maxHttpBufferSize: config.socket.maxPayloadBytes,
    // Deteksi koneksi mati lebih cepat dari default (25s + 20s), penting untuk mobile.
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  const rooms = new RoomService({
    store: options.store ?? new MemoryRoomStore(),
    modules: new ModuleRegistry(options.modules),
    notifier: new SocketNotifier(io),
    logger,
    config: config.room,
  });
  const presence = new PresenceTracker(rooms, logger);

  const app = createHttpApp({
    config,
    rooms,
    logger,
    ...(options.registerRoutes && { registerRoutes: options.registerRoutes }),
  });
  httpServer.on("request", app);

  setupSocketLayer({
    io,
    config,
    rooms,
    presence,
    authenticator: options.authenticator ?? createAuthenticatorFromConfig(config.auth),
    logger,
  });

  let sweeper: NodeJS.Timeout | null = null;

  return {
    app,
    httpServer,
    io,
    rooms,
    logger,

    start: () =>
      new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off("error", reject);
          sweeper = setInterval(() => {
            rooms.sweepIdleRooms().catch((error: unknown) => logger.error({ err: error }, "room sweep failed"));
          }, config.room.sweepIntervalMs);
          sweeper.unref();
          resolve((httpServer.address() as AddressInfo).port);
        });
      }),

    stop: async () => {
      if (sweeper) clearInterval(sweeper);
      presence.stop();
      await rooms.closeAll("server-shutdown");
      await io.close(); // juga menutup httpServer
    },
  };
}
