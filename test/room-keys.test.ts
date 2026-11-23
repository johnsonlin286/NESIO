import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, type Database } from "../src/project/db/client.js";
import * as schema from "../src/project/db/schema.js";
import { afterRefund, afterSpend, currentKeys, ROOM_KEYS } from "../src/project/keys/rules.js";
import { NO_ROOM_KEYS, RoomKeyService } from "../src/project/keys/service.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

describe("aturan isi ulang kunci (tanpa database)", () => {
  it("penuh tetap penuh, tanpa waktu kunci berikutnya", () => {
    expect(currentKeys({ count: 5, updatedAt: T0 }, T0 + 999 * MIN)).toMatchObject({ count: 5, nextAt: null });
  });

  it("+1 setiap 30 menit sampai penuh, sisa progres tidak hilang", () => {
    const stored = { count: 1, updatedAt: T0 };
    expect(currentKeys(stored, T0 + 29 * MIN)).toMatchObject({ count: 1, nextAt: T0 + 30 * MIN });
    expect(currentKeys(stored, T0 + 30 * MIN)).toMatchObject({ count: 2, nextAt: T0 + 60 * MIN });
    // 75 menit: dua kunci matang, 15 menit progres ke kunci ketiga tetap diingat.
    expect(currentKeys(stored, T0 + 75 * MIN)).toMatchObject({ count: 3, nextAt: T0 + 90 * MIN, stored: { count: 3, updatedAt: T0 + 60 * MIN } });
    expect(currentKeys(stored, T0 + 10 * 60 * MIN)).toMatchObject({ count: 5, nextAt: null });
  });

  it("tabel per tingkat: makin sedikit kunci, makin lama (siap untuk opsi lain)", () => {
    const slowWhenLow = { max: 5, regenMinutes: [60, 45, 30, 20, 15] };
    const fromZero = { count: 0, updatedAt: T0 };
    expect(currentKeys(fromZero, T0 + 59 * MIN, slowWhenLow).count).toBe(0);
    expect(currentKeys(fromZero, T0 + 60 * MIN, slowWhenLow)).toMatchObject({ count: 1, nextAt: T0 + 105 * MIN });
    // 0 sampai 5: 60 + 45 + 30 + 20 + 15 = 170 menit.
    expect(currentKeys(fromZero, T0 + 169 * MIN, slowWhenLow).count).toBe(4);
    expect(currentKeys(fromZero, T0 + 170 * MIN, slowWhenLow).count).toBe(5);
  });

  it("memakai kunci dari penuh memulai timer sekarang; dari tidak penuh progres tetap", () => {
    const full = currentKeys({ count: 5, updatedAt: T0 }, T0 + 5 * MIN);
    expect(afterSpend(full, T0 + 5 * MIN)).toEqual({ count: 4, updatedAt: T0 + 5 * MIN });
    const partial = currentKeys({ count: 2, updatedAt: T0 }, T0 + 10 * MIN);
    expect(afterSpend(partial, T0 + 10 * MIN)).toEqual({ count: 1, updatedAt: T0 });
  });

  it("pengembalian tidak melebihi batas", () => {
    const four = currentKeys({ count: 4, updatedAt: T0 }, T0 + MIN);
    expect(afterRefund(four, T0 + MIN)).toEqual({ count: 5, updatedAt: T0 + MIN });
    const full = currentKeys({ count: 5, updatedAt: T0 }, T0 + MIN);
    expect(afterRefund(full, T0 + MIN).count).toBe(ROOM_KEYS.max);
  });
});

describe("RoomKeyService (Postgres)", () => {
  let pg: PGlite;
  let db: Database;
  let clock = T0;
  let userId = "";

  beforeAll(async () => {
    pg = new PGlite();
    const pgliteDb = drizzle({ client: pg, schema });
    await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
    db = pgliteDb as unknown as Database;
  });

  afterEach(async () => {
    await pg.exec("TRUNCATE users CASCADE");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function newUser(keys = 5) {
    clock = T0;
    const [user] = await db
      .insert(schema.users)
      .values({ googleSub: `sub-${Math.random()}`, roomKeys: keys, roomKeysUpdatedAt: new Date(T0) })
      .returning();
    userId = user!.id;
    return new RoomKeyService(db, ROOM_KEYS, () => clock);
  }

  it("memakai sampai habis, lalu NO_ROOM_KEYS dengan waktu kunci berikutnya", async () => {
    const keys = await newUser(2);
    expect((await keys.spend(userId)).count).toBe(1);
    expect((await keys.spend(userId)).count).toBe(0);
    await expect(keys.spend(userId)).rejects.toMatchObject({ code: NO_ROOM_KEYS, details: { nextAt: T0 + 30 * MIN } });
  });

  it("kunci bertambah seiring waktu server", async () => {
    const keys = await newUser(5);
    await keys.spend(userId);
    expect(await keys.status(userId)).toEqual({ count: 4, max: 5, nextAt: T0 + 30 * MIN, serverNow: T0 });
    clock = T0 + 30 * MIN;
    expect(await keys.status(userId)).toEqual({ count: 5, max: 5, nextAt: null, serverNow: T0 + 30 * MIN });
  });

  it("pemakaian bersamaan tidak membuat kunci negatif", async () => {
    const keys = await newUser(1);
    const results = await Promise.allSettled([keys.spend(userId), keys.spend(userId), keys.spend(userId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await keys.status(userId)).count).toBe(0);
  });

  it("pengembalian menambah satu kunci, maksimal penuh", async () => {
    const keys = await newUser(3);
    expect((await keys.refund(userId)).count).toBe(4);
    expect((await keys.refund(userId)).count).toBe(5);
    expect((await keys.refund(userId)).count).toBe(5);
  });

  it("akun tidak dikenal ditolak", async () => {
    const keys = await newUser();
    await expect(keys.status("bukan-uuid")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(keys.status("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
