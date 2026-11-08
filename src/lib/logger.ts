import { pino, type Logger } from "pino";
import type { AppConfig } from "../config/env.js";

export type { Logger };

export function createLogger(config: Pick<AppConfig, "logLevel" | "isProduction" | "env">): Logger {
  const usePretty = !config.isProduction && config.env !== "test";
  return pino({
    level: config.logLevel,
    redact: {
      paths: ["*.token", "*.sessionToken", "*.password", "*.authorization", "*.cookie"],
      censor: "[redacted]",
    },
    ...(usePretty && {
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      },
    }),
  });
}
