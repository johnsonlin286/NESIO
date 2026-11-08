import dotenv from "dotenv";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { modules } from "./modules/index.js";
import { createRoomServer } from "./server.js";

dotenv.config({ quiet: true });

const config = loadConfig();
const logger = createLogger(config);

if (config.auth.mode === "guest" && !process.env.SESSION_SECRET) {
  logger.warn("SESSION_SECRET belum diisi, memakai secret development. JANGAN dipakai di production.");
}

const server = createRoomServer({ config, modules, logger });

const port = await server.start();
logger.info({ port, env: config.env, auth: config.auth.mode, modules: modules.map((m) => m.type) }, "server ready");

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  const forceExit = setTimeout(() => {
    logger.error("shutdown timeout, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await server.stop();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception");
  void shutdown("uncaughtException");
});
