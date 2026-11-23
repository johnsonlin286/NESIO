import type { Logger } from "../../lib/logger.js";
import { connectDatabase } from "../db/client.js";
import { RoomKeyService } from "../keys/service.js";
import { loadAppAuthConfig } from "./config.js";
import { createGoogleVerifier } from "./google.js";
import { AuthService } from "./service.js";

export { createAppAuthenticator } from "./authenticator.js";
export { authRouter } from "./routes.js";
export { AuthService } from "./service.js";

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AppAuth {
  service: AuthService;
  keys: RoomKeyService;
  close(): Promise<void>;
}

/** Login aplikasi dari environment; null (nonaktif) kalau DATABASE_URL belum diisi di development. */
export async function createAppAuthFromEnv(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<AppAuth | null> {
  const config = loadAppAuthConfig(env);
  if (!config) {
    logger.warn("DATABASE_URL belum diisi: login aplikasi Android nonaktif, pemain web tetap bisa main.");
    return null;
  }
  if (config.insecureDevSecret) {
    logger.warn("APP_JWT_SECRET belum diisi, memakai secret development. JANGAN dipakai di production.");
  }

  const database = await connectDatabase(config.databaseUrl);
  const service = new AuthService({
    db: database.db,
    verifyGoogle: createGoogleVerifier(config.googleClientIds),
    jwtSecret: config.jwtSecret,
    accessTokenTtlSec: config.accessTokenTtlSec,
    refreshTokenTtlDays: config.refreshTokenTtlDays,
  });

  const prune = setInterval(() => {
    service
      .pruneExpired()
      .then((count) => count > 0 && logger.info({ count }, "expired refresh tokens pruned"))
      .catch((error: unknown) => logger.error({ err: error }, "refresh token prune failed"));
  }, PRUNE_INTERVAL_MS);
  prune.unref();

  return {
    service,
    keys: new RoomKeyService(database.db),
    close: async () => {
      clearInterval(prune);
      await database.close();
    },
  };
}
