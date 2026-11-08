import { createAuthenticatorFromConfig } from "../auth/index.js";
import type { AppConfig } from "../config/env.js";
import { MemoryRoomStore } from "../core/store/memory-room-store.js";
import type { Logger } from "../lib/logger.js";
import { modules } from "../modules/index.js";
import { createRoomServer, type RoomServer } from "../server.js";
import { LobbyAwareRoomStore } from "./lobby-store.js";
import { createPlayerNameGuard } from "./player-names.js";

/**
 * Room server dengan aturan khusus ABC Words:
 * nama pemain unik & aman, dan sinyal `rooms:changed` untuk daftar room lobby.
 */
export function createAbcWordsServer(config: AppConfig, logger?: Logger): RoomServer {
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
    ...(logger && { logger }),
    authenticator: names.authenticate,
  });
  names.attach(server.io);
  return server;
}
