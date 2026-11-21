import { z } from "zod";

const DEV_JWT_SECRET = "dev-only-insecure-app-jwt-secret-change-me!!";

const csv = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).optional(),
  APP_JWT_SECRET: z.string().min(32).optional(),
  /** Client ID OAuth yang boleh menjadi `aud` ID token Google (Web client ID aplikasi Android). */
  GOOGLE_CLIENT_IDS: csv,
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

export interface AppAuthConfig {
  databaseUrl: string;
  jwtSecret: string;
  googleClientIds: string[];
  accessTokenTtlSec: number;
  refreshTokenTtlDays: number;
  /** true kalau memakai secret development (hanya untuk peringatan di log). */
  insecureDevSecret: boolean;
}

/**
 * Login aplikasi (Google + JWT) butuh Postgres. Tanpa DATABASE_URL fitur ini mati (null) dan
 * server tetap jalan untuk pemain web (guest), kecuali di production yang wajib lengkap.
 */
export function loadAppAuthConfig(source: NodeJS.ProcessEnv = process.env): AppAuthConfig | null {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Konfigurasi login aplikasi tidak valid:\n${issues}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === "production";

  if (!env.DATABASE_URL) {
    if (production) throw new Error("DATABASE_URL wajib diisi di production (login aplikasi)");
    return null;
  }
  if (production && !env.APP_JWT_SECRET) throw new Error("APP_JWT_SECRET wajib diisi di production (min 32 karakter)");
  if (env.GOOGLE_CLIENT_IDS.length === 0) throw new Error("GOOGLE_CLIENT_IDS wajib diisi kalau DATABASE_URL diisi");

  return {
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.APP_JWT_SECRET ?? DEV_JWT_SECRET,
    googleClientIds: env.GOOGLE_CLIENT_IDS,
    accessTokenTtlSec: env.ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    insecureDevSecret: !env.APP_JWT_SECRET,
  };
}
