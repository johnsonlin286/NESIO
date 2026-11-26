/**
 * Kunci room (hanya akun aplikasi Android; tamu web tidak punya kunci). Membuat room butuh minimal
 * satu kunci dan host memakai satu setiap memulai permainan; pemain yang bergabung gratis.
 *
 * `regenMinutes[n]` = waktu dari n kunci ke n + 1, jadi isi ulang bisa dibuat makin lambat atau
 * makin cepat per tingkat hanya dengan mengubah tabel ini (tanpa migrasi data). Sama dengan
 * `ROOM_KEYS` di client/src/shared/game.ts.
 */
export const ROOM_KEYS = { max: 5, regenMinutes: [30, 30, 30, 30, 30] } as const;

const MINUTE_MS = 60_000;

export interface KeySchedule {
  max: number;
  regenMinutes: readonly number[];
}

export interface StoredKeys {
  /** Jumlah kunci saat `updatedAt`. */
  count: number;
  /** Titik mulai hitungan isi ulang berikutnya (epoch ms). */
  updatedAt: number;
}

export interface CurrentKeys {
  count: number;
  /** Kapan kunci berikutnya datang (epoch ms), atau null kalau sudah penuh. */
  nextAt: number | null;
  /** Nilai yang disimpan supaya sisa progres isi ulang tidak hilang. */
  stored: StoredKeys;
}

/**
 * Jumlah kunci sekarang, dihitung dari data tersimpan dan waktu yang berlalu (jam server, bukan HP).
 * Tidak ada job terjadwal: setiap kali dibaca, kunci yang sudah "matang" ditambahkan.
 */
export function currentKeys(stored: StoredKeys, now: number, schedule: KeySchedule = ROOM_KEYS): CurrentKeys {
  let count = Math.min(stored.count, schedule.max);
  let anchor = stored.updatedAt;
  while (count < schedule.max) {
    const step = stepMs(schedule, count);
    if (now - anchor < step) break;
    anchor += step;
    count += 1;
  }
  const full = count >= schedule.max;
  return {
    count,
    nextAt: full ? null : anchor + stepMs(schedule, count),
    // Penuh: tidak ada progres yang perlu diingat, mulai hitung lagi dari sekarang saat dipakai.
    stored: { count, updatedAt: full ? now : anchor },
  };
}

/** Setelah memakai satu kunci. Dari kondisi penuh, isi ulang baru mulai berjalan sekarang. */
export function afterSpend(current: CurrentKeys, now: number): StoredKeys {
  const wasFull = current.nextAt === null;
  return { count: current.count - 1, updatedAt: wasFull ? now : current.stored.updatedAt };
}

/** Kunci dikembalikan (server dimatikan sebelum ronde pertama selesai), tidak melebihi batas. */
export function afterRefund(current: CurrentKeys, now: number, schedule: KeySchedule = ROOM_KEYS): StoredKeys {
  const count = Math.min(current.count + 1, schedule.max);
  return { count, updatedAt: count >= schedule.max ? now : current.stored.updatedAt };
}

function stepMs(schedule: KeySchedule, count: number): number {
  const minutes = schedule.regenMinutes[count] ?? schedule.regenMinutes.at(-1) ?? 30;
  return minutes * MINUTE_MS;
}
