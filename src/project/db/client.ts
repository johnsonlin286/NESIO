import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema.js";

/** Tipe bersama untuk node-postgres (server) dan PGlite (test). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Folder migrasi SQL dari drizzle-kit; sama dari src/ maupun dist/. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export interface DatabaseHandle {
  db: Database;
  close(): Promise<void>;
}

/**
 * Pool kecil: VPS menjalankan beberapa game di satu Postgres, dan query di sini singkat
 * (login, refresh). Migrasi dijalankan sekali saat start; aman dipanggil berulang.
 */
export async function connectDatabase(url: string, { max = 5 }: { max?: number } = {}): Promise<DatabaseHandle> {
  const pool = new Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
  const db = drizzle({ client: pool, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => pool.end() };
}
