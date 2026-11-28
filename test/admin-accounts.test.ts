import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { findAccounts } from "../src/project/admin/accounts.js";
import { deleteAccount } from "../src/project/auth/service.js";
import { MIGRATIONS_FOLDER, type Database } from "../src/project/db/client.js";
import * as schema from "../src/project/db/schema.js";
import { refreshTokens, users } from "../src/project/db/schema.js";

let pg: PGlite;
let db: Database;

beforeAll(async () => {
  pg = new PGlite();
  const pgliteDb = drizzle({ client: pg, schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb as unknown as Database;
});

afterEach(async () => {
  await pg.exec("TRUNCATE users, refresh_tokens CASCADE");
});

afterAll(async () => {
  await pg.close();
});

async function account(sub: string, email: string, displayName: string | null) {
  const [row] = await db.insert(users).values({ googleSub: sub, email, displayName }).returning();
  await db.insert(refreshTokens).values({
    userId: row!.id,
    familyId: crypto.randomUUID(),
    tokenHash: `hash-${sub}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return row!;
}

describe("admin: hapus akun lewat permintaan email", () => {
  it("menemukan akun dari email, nama panggilan atau id, tanpa membedakan huruf besar/kecil", async () => {
    const ani = await account("sub-ani", "Ani.Putri@gmail.com", "Ani");
    await account("sub-budi", "budi@gmail.com", "Budi");

    for (const query of ["ani.putri@GMAIL.com", "  aNi ", ani.id]) {
      const found = await findAccounts(db, query);
      expect(found.map((a) => a.id)).toEqual([ani.id]);
    }
    expect(await findAccounts(db, "nobody@gmail.com")).toEqual([]);
    expect(await findAccounts(db, "   ")).toEqual([]);
  });

  it("menghapus akun beserta semua token login-nya, akun lain tetap ada", async () => {
    const ani = await account("sub-ani", "ani@gmail.com", "Ani");
    const budi = await account("sub-budi", "budi@gmail.com", "Budi");

    expect(await deleteAccount(db, ani.id)).toBe(true);
    expect(await findAccounts(db, "ani@gmail.com")).toEqual([]);
    const tokens = await db.select().from(refreshTokens);
    expect(tokens.map((t) => t.userId)).toEqual([budi.id]);

    // Sekali lagi, atau id yang bukan UUID: tidak ada yang terhapus.
    expect(await deleteAccount(db, ani.id)).toBe(false);
    expect(await deleteAccount(db, "ani@gmail.com")).toBe(false);
    expect(await findAccounts(db, "Budi")).toHaveLength(1);
  });

  it("nama panggilan bebas lagi setelah akunnya dihapus", async () => {
    const ani = await account("sub-ani", "ani@gmail.com", "Ani");
    await deleteAccount(db, ani.id);
    await expect(account("sub-lain", "lain@gmail.com", "ANI")).resolves.toBeDefined();
  });
});
