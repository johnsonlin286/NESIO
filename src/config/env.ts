import { z } from "zod";

const DEV_SESSION_SECRET = "dev-only-insecure-session-secret-change-me!!";

const csv = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    // HTTP
    CORS_ORIGIN: csv,
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

    // Auth
    AUTH_MODE: z.enum(["guest", "jwt"]).default("guest"),
    SESSION_SECRET: z.string().min(32).optional(),
    JWT_SECRET: z.string().min(32).optional(),
    JWT_JWKS_URL: z.url().optional(),
    JWT_ISSUER: z.string().optional(),
    JWT_AUDIENCE: z.string().optional(),

    // Socket
    SOCKET_MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(100 * 1024),
    SOCKET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    SOCKET_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(1000),

    // Room
    RECONNECT_GRACE_MS: z.coerce.number().int().min(0).default(30_000),
    ROOM_IDLE_TTL_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
    ROOM_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    ROOM_DEFAULT_MAX_MEMBERS: z.coerce.number().int().min(1).default(8),
    ROOM_MAX_MEMBERS_LIMIT: z.coerce.number().int().min(1).default(50),
    HOST_LEAVE_POLICY: z.enum(["migrate", "close"]).default("migrate"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (env.CORS_ORIGIN.length === 0) {
        ctx.addIssue({ code: "custom", path: ["CORS_ORIGIN"], message: "wajib diisi di production" });
      }
      if (env.AUTH_MODE === "guest" && !env.SESSION_SECRET) {
        ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "wajib diisi di production (min 32 karakter)" });
      }
    }
    if (env.AUTH_MODE === "jwt" && !env.JWT_SECRET && !env.JWT_JWKS_URL) {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "AUTH_MODE=jwt butuh JWT_SECRET atau JWT_JWKS_URL" });
    }
    if (env.ROOM_DEFAULT_MAX_MEMBERS > env.ROOM_MAX_MEMBERS_LIMIT) {
      ctx.addIssue({ code: "custom", path: ["ROOM_DEFAULT_MAX_MEMBERS"], message: "tidak boleh melebihi ROOM_MAX_MEMBERS_LIMIT" });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env["NODE_ENV"];
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: Env["LOG_LEVEL"];
  http: {
    corsOrigins: string[];
    trustProxy: number;
    rateLimit: { windowMs: number; max: number };
  };
  auth:
    | { mode: "guest"; sessionSecret: string }
    | { mode: "jwt"; secret?: string; jwksUrl?: string; issuer?: string; audience?: string };
  socket: {
    maxPayloadBytes: number;
    rateLimit: { max: number; windowMs: number };
  };
  room: {
    reconnectGraceMs: number;
    idleTtlMs: number;
    sweepIntervalMs: number;
    defaultMaxMembers: number;
    maxMembersLimit: number;
    hostLeavePolicy: "migrate" | "close";
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // `KEY=` (kosong) di file .env dianggap tidak diisi, sehingga default berlaku.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Konfigurasi environment tidak valid:\n${issues}`);
  }
  const env = parsed.data;

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    http: {
      corsOrigins: env.CORS_ORIGIN,
      trustProxy: env.TRUST_PROXY,
      rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
    },
    auth:
      env.AUTH_MODE === "guest"
        ? { mode: "guest", sessionSecret: env.SESSION_SECRET ?? DEV_SESSION_SECRET }
        : {
            mode: "jwt",
            ...(env.JWT_SECRET && { secret: env.JWT_SECRET }),
            ...(env.JWT_JWKS_URL && { jwksUrl: env.JWT_JWKS_URL }),
            ...(env.JWT_ISSUER && { issuer: env.JWT_ISSUER }),
            ...(env.JWT_AUDIENCE && { audience: env.JWT_AUDIENCE }),
          },
    socket: {
      maxPayloadBytes: env.SOCKET_MAX_PAYLOAD_BYTES,
      rateLimit: { max: env.SOCKET_RATE_LIMIT_MAX, windowMs: env.SOCKET_RATE_LIMIT_WINDOW_MS },
    },
    room: {
      reconnectGraceMs: env.RECONNECT_GRACE_MS,
      idleTtlMs: env.ROOM_IDLE_TTL_MS,
      sweepIntervalMs: env.ROOM_SWEEP_INTERVAL_MS,
      defaultMaxMembers: env.ROOM_DEFAULT_MAX_MEMBERS,
      maxMembersLimit: env.ROOM_MAX_MEMBERS_LIMIT,
      hostLeavePolicy: env.HOST_LEAVE_POLICY,
    },
  };
}
