import cors, { type CorsOptions } from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { AppConfig } from "../config/env.js";
import type { RoomService } from "../core/room-service.js";
import { AppError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { healthRouter } from "./routes/health.js";
import { roomsRouter } from "./routes/rooms.js";

export interface HttpAppDeps {
  config: AppConfig;
  rooms: RoomService;
  logger: Logger;
  /** Tambahkan route khusus project di sini tanpa mengubah file core. */
  registerRoutes?: (app: Express) => void;
}

export function createCorsOptions(config: AppConfig): CorsOptions {
  return {
    // Tanpa allowlist (hanya boleh di development) semua origin diizinkan.
    origin: config.http.corsOrigins.length > 0 ? config.http.corsOrigins : true,
    credentials: true,
  };
}

export function createHttpApp({ config, rooms, logger, registerRoutes }: HttpAppDeps): Express {
  const app = express();
  const log = logger.child({ component: "http" });

  app.set("trust proxy", config.http.trustProxy);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(cors(createCorsOptions(config)));
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  // Health check sebelum rate limit supaya load balancer / uptime monitor tidak terblokir.
  app.use("/health", healthRouter());

  app.use(
    "/api",
    rateLimit({
      windowMs: config.http.rateLimit.windowMs,
      limit: config.http.rateLimit.max,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ ok: false, error: { code: "RATE_LIMITED", message: "Terlalu banyak request" } });
      },
    }),
  );
  app.use("/api/rooms", roomsRouter(rooms));
  registerRoutes?.(app);

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Endpoint tidak ditemukan" } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(statusForCode(err.code)).json({ ok: false, error: err.toPayload() });
      return;
    }
    // Error dari body-parser (JSON rusak / terlalu besar) punya `status` < 500.
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status >= 500) log.error({ err }, "unhandled http error");
    res.status(status).json({
      ok: false,
      error: {
        code: status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: status >= 500 ? "Terjadi kesalahan pada server" : "Request tidak valid",
      },
    });
  });

  return app;
}

function statusForCode(code: string): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "NOT_HOST":
      return 403;
    case "ROOM_NOT_FOUND":
    case "MEMBER_NOT_FOUND":
      return 404;
    case "RATE_LIMITED":
      return 429;
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 400;
  }
}
