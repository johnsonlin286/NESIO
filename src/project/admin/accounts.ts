import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountMatch {
  id: string;
  email: string | null;
  displayName: string | null;
  createdAt: Date;
  lastLoginAt: Date;
}

/**
 * Cari akun untuk permintaan admin (misalnya hapus akun lewat email): id akun, email, atau nama
 * panggilan. Email dan nama dibandingkan tanpa membedakan huruf besar/kecil. Bisa lebih dari satu
 * hasil untuk email (satu email, dua akun Google tidak mungkin, tapi data lama bisa berbeda).
 */
export async function findAccounts(db: Database, query: string): Promise<AccountMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const where = UUID_PATTERN.test(q)
    ? eq(users.id, q)
    : q.includes("@")
      ? eq(sql`lower(${users.email})`, q.toLowerCase())
      : eq(sql`lower(${users.displayName})`, q.toLowerCase());
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(where);
}
