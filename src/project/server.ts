import { createAuthenticatorFromConfig } from "../auth/index.js";
import type { AppConfig } from "../config/env.js";
import type { AnyRoomModule } from "../core/module.js";
import { MemoryRoomStore } from "../core/store/memory-room-store.js";
import { createLogger, type Logger } from "../lib/logger.js";
import { modules as defaultModules } from "../modules/index.js";
import { createRoomServer, type RoomServer } from "../server.js";
import { startGameClock } from "./game-clock.js";
import { LobbyAwareRoomStore } from "./lobby-store.js";
import { createPlayerNameGuard } from "./player-names.js";

/**
 * Room server dengan aturan khusus ABC Words:
 * nama pemain unik & aman, sinyal `rooms:changed` untuk daftar room lobby,
 * dan jam yang memajukan fase game.
 */
export function createAbcWordsServer(
  config: AppConfig,
  logger: Logger = createLogger(config),
  modules: AnyRoomModule[] = defaultModules,
  { hostAwayMs = 5_000 }: { hostAwayMs?: number } = {},
): RoomServer {
  const store = new LobbyAwareRoomStore(new MemoryRoomStore(), () => server.io.emit("rooms:changed"));
  const names = createPlayerNameGuard({
    base: createAuthenticatorFromConfig(config.auth),
    store,
    io: () => server.io,
  });
  const server: RoomServer = createRoomServer({
    config,
    modules,
    store,
    logger,
    authenticator: names.authenticate,
  });
  names.attach(server.io);

  const stopClock = startGameClock({ store, rooms: server.rooms, logger, hostAwayMs });
  return {
    ...server,
    stop: async () => {
      stopClock();
      await server.stop();
    },
  };
}
