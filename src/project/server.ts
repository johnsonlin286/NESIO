import { createAuthenticatorFromConfig } from "../auth/index.js";
import type { AppConfig } from "../config/env.js";
import type { AnyRoomModule } from "../core/module.js";
import { MemoryRoomStore } from "../core/store/memory-room-store.js";
import { createLogger, type Logger } from "../lib/logger.js";
import { unspentKeyHolder, type AbcWordsDeps } from "../modules/abc-words/index.js";
import { createModules } from "../modules/index.js";
import { createRoomServer, type RoomServer } from "../server.js";
import { authRouter, createAppAuthenticator, type AppAuth } from "./auth/index.js";
import { startGameClock } from "./game-clock.js";
import { createHostKeys } from "./keys/host-keys.js";
import { lobbyRouter } from "./lobby-routes.js";
import { LobbyAwareRoomStore } from "./lobby-store.js";
import { createPlayerNameGuard } from "./player-names.js";

/**
 * Room server dengan aturan khusus ABC Lima Dasar:
 * nama pemain unik & aman, sinyal `rooms:changed` untuk daftar room lobby,
 * jam yang memajukan fase game, dan login aplikasi Android (`appAuth`, opsional)
 * di samping pemain web yang tetap guest. Host dari aplikasi membayar kunci room, dan daftar lobby
 * aplikasi menandai room yang host-nya kehabisan kunci.
 */
export function createAbcWordsServer(
  config: AppConfig,
  logger: Logger = createLogger(config),
  modules: AnyRoomModule[] | ((deps: AbcWordsDeps) => AnyRoomModule[]) = createModules,
  { hostAwayMs = 5_000, appAuth = null }: { hostAwayMs?: number; appAuth?: AppAuth | null } = {},
): RoomServer {
  const store = new LobbyAwareRoomStore(new MemoryRoomStore(), () => server.io.emit("rooms:changed"));
  const names = createPlayerNameGuard({
    base: createAppAuthenticator(createAuthenticatorFromConfig(config.auth), appAuth?.service ?? null, logger),
    store,
    io: () => server.io,
  });
  const roomKeys = appAuth ? createHostKeys(appAuth.keys, () => server.io, logger) : undefined;
  const server: RoomServer = createRoomServer({
    config,
    modules: typeof modules === "function" ? modules(roomKeys ? { roomKeys } : {}) : modules,
    store,
    logger,
    authenticator: names.authenticate,
    registerRoutes: (app) => {
      app.use(
        "/api/auth",
        authRouter(appAuth?.service ?? null, {
          ...(appAuth && { keys: appAuth.keys }),
          nameInUse: async (name, userId) => {
            const holder = await names.holderOf(name);
            return holder !== null && holder !== userId;
          },
        }),
      );
      app.use(
        "/api/abc-words/rooms",
        lobbyRouter({ rooms: () => server.rooms, store, keys: appAuth?.keys ?? null, logger }),
      );
    },
  });
  names.attach(server.io);

  const stopClock = startGameClock({ store, rooms: server.rooms, logger, hostAwayMs });
  return {
    ...server,
    stop: async () => {
      stopClock();
      // Satu-satunya pengembalian kunci: server berhenti memotong permainan yang ronde pertamanya belum selesai.
      if (roomKeys) {
        const holders = (await store.list()).map(unspentKeyHolder).filter((id) => id !== null);
        await Promise.all(holders.map((id) => roomKeys.refund(id)));
      }
      await server.stop();
      await appAuth?.close();
    },
  };
}
