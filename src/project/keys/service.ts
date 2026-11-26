import { eq, inArray } from "drizzle-orm";
import { AppError, Errors } from "../../lib/errors.js";
import type { RoomKeyStatus } from "../../shared/contract.js";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { afterRefund, afterSpend, currentKeys, ROOM_KEYS, type CurrentKeys, type KeySchedule } from "./rules.js";

export const NO_ROOM_KEYS = "NO_ROOM_KEYS";

export function noRoomKeysError(nextAt: number | null): AppError {
  return new AppError(NO_ROOM_KEYS, "Kunci room habis. Tunggu kunci berikutnya.", { nextAt });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kunci room per akun di Postgres. Baca selalu menghitung ulang dari waktu server; pakai dan
 * kembalikan berjalan dalam transaksi dengan baris user dikunci (`FOR UPDATE`), jadi dua
 * permintaan bersamaan tidak bisa memakai kunci yang sama atau membuatnya negatif.
 */
export class RoomKeyService {
  constructor(
    private readonly db: Database,
    private readonly schedule: KeySchedule = ROOM_KEYS,
    private readonly now: () => number = Date.now,
  ) {}

  async status(userId: string): Promise<RoomKeyStatus> {
    if (!UUID_PATTERN.test(userId)) throw Errors.unauthorized("Akun tidak ditemukan");
    const [row] = await this.db
      .select({ count: users.roomKeys, updatedAt: users.roomKeysUpdatedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) throw Errors.unauthorized("Akun tidak ditemukan");
    const now = this.now();
    return this.toStatus(currentKeys({ count: row.count, updatedAt: row.updatedAt.getTime() }, now, this.schedule), now);
  }

  /** Pakai satu kunci (host memulai permainan). NO_ROOM_KEYS kalau habis. */
  spend(userId: string): Promise<RoomKeyStatus> {
    return this.update(userId, (current, now) => {
      if (current.count <= 0) {
        throw noRoomKeysError(current.nextAt);
      }
      return afterSpend(current, now);
    });
  }

  /** Dari daftar pemain ini, akun yang sedang tidak punya kunci (tamu web tidak punya baris). */
  async keylessAmong(userIds: string[]): Promise<Set<string>> {
    const ids = userIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ id: users.id, count: users.roomKeys, updatedAt: users.roomKeysUpdatedAt })
      .from(users)
      .where(inArray(users.id, ids));
    const now = this.now();
    const empty = rows.filter(
      (row) => currentKeys({ count: row.count, updatedAt: row.updatedAt.getTime() }, now, this.schedule).count === 0,
    );
    return new Set(empty.map((row) => row.id));
  }

  /** Kembalikan satu kunci (server dimatikan sebelum ronde pertama selesai). */
  refund(userId: string): Promise<RoomKeyStatus> {
    return this.update(userId, (current, now) => afterRefund(current, now, this.schedule));
  }

  private async update(
    userId: string,
    next: (current: CurrentKeys, now: number) => { count: number; updatedAt: number },
  ): Promise<RoomKeyStatus> {
    if (!UUID_PATTERN.test(userId)) throw Errors.unauthorized("Akun tidak ditemukan");
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ count: users.roomKeys, updatedAt: users.roomKeysUpdatedAt })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!row) throw Errors.unauthorized("Akun tidak ditemukan");

      const now = this.now();
      const stored = next(currentKeys({ count: row.count, updatedAt: row.updatedAt.getTime() }, now, this.schedule), now);
      await tx
        .update(users)
        .set({ roomKeys: stored.count, roomKeysUpdatedAt: new Date(stored.updatedAt) })
        .where(eq(users.id, userId));
      return this.toStatus(currentKeys(stored, now, this.schedule), now);
    });
  }

  private toStatus(current: CurrentKeys, now: number): RoomKeyStatus {
    return { count: current.count, max: this.schedule.max, nextAt: current.nextAt, serverNow: now };
  }
}
