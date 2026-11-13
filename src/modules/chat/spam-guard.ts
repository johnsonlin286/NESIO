/**
 * Penjaga chat room: pesan spam (terlalu banyak, atau sama berulang-ulang) dan pesan berisi kata
 * kasar ditolak dan tidak ditampilkan. Keduanya dihitung sebagai pelanggaran yang sama;
 * pelanggaran berikutnya membuat pemain dibisukan sementara.
 * Hanya pemain itu yang diberi tahu, supaya tidak mempermalukan atau memancing drama.
 *
 * Catatan disimpan di luar state room (dalam memori proses), karena pesan yang ditolak dikirim
 * lewat `ctx.fail`, yang membatalkan semua perubahan state room.
 */

export interface ChatSpamRules {
  /** Lebih dari `floodLimit` pesan dalam `floodWindowMs` dianggap spam. */
  floodLimit: number;
  floodWindowMs: number;
  /** Pesan yang sama `repeatLimit` kali berturut-turut dalam `repeatWindowMs` dianggap spam. */
  repeatLimit: number;
  repeatWindowMs: number;
  /** Pelanggaran ke-`offensesToMute` dalam `offenseWindowMs` membuat pemain dibisukan `muteMs`. */
  offensesToMute: number;
  offenseWindowMs: number;
  muteMs: number;
}

export const DEFAULT_CHAT_SPAM_RULES: ChatSpamRules = {
  floodLimit: 5,
  floodWindowMs: 10_000,
  repeatLimit: 3,
  repeatWindowMs: 30_000,
  offensesToMute: 2,
  offenseWindowMs: 10 * 60_000,
  muteMs: 2 * 60_000,
};

export const CHAT_SLOW_DOWN = "CHAT_SLOW_DOWN";
export const CHAT_PROFANITY = "CHAT_PROFANITY";
export const CHAT_MUTED = "CHAT_MUTED";

export type ChatSpamVerdict =
  | { ok: true }
  /** `retryAfterMs` ada kalau pemain sedang (atau baru saja) dibisukan. */
  | {
      ok: false;
      code: typeof CHAT_SLOW_DOWN | typeof CHAT_PROFANITY | typeof CHAT_MUTED;
      message: string;
      retryAfterMs?: number;
    };

interface SenderRecord {
  /** Waktu pesan yang berhasil terkirim, untuk hitungan banjir pesan. */
  sentAt: number[];
  /** Pesan terakhir yang terkirim (sudah dinormalisasi) dan berapa kali berturut-turut. */
  lastText: string;
  lastTextCount: number;
  lastTextAt: number;
  offenses: number[];
  mutedUntil: number;
}

function minutesText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? "1 menit" : `${minutes} menit`;
}

/**
 * @param isProfane pemeriksa kata kasar (lihat `./profanity.ts`); tanpa ini, hanya spam yang dicek.
 */
export function createChatSpamGuard(
  rules: ChatSpamRules = DEFAULT_CHAT_SPAM_RULES,
  isProfane: (text: string) => boolean = () => false,
) {
  /** Kunci: `roomId:userId`. */
  const records = new Map<string, SenderRecord>();

  function prune(now: number): void {
    for (const [key, r] of records) {
      const idle = r.sentAt.every((at) => now - at >= rules.repeatWindowMs);
      const clean = r.offenses.every((at) => now - at >= rules.offenseWindowMs);
      if (idle && clean && r.mutedUntil <= now) records.delete(key);
    }
  }

  function recordFor(key: string): SenderRecord {
    let r = records.get(key);
    if (!r) {
      r = { sentAt: [], lastText: "", lastTextCount: 0, lastTextAt: 0, offenses: [], mutedUntil: 0 };
      records.set(key, r);
    }
    return r;
  }

  function mutedVerdict(retryAfterMs: number): ChatSpamVerdict {
    return {
      ok: false,
      code: CHAT_MUTED,
      message: `Kamu dibisukan karena melanggar aturan chat. Bisa mengirim pesan lagi dalam ${minutesText(retryAfterMs)}.`,
      retryAfterMs,
    };
  }

  return {
    /**
     * Dipanggil sebelum pesan dikirim. Kalau `ok`, pesan dianggap terkirim dan dicatat;
     * kalau tidak, pesan harus ditolak dengan `code` dan `message` yang dikembalikan.
     */
    check(roomId: string, userId: string, text: string, now: number): ChatSpamVerdict {
      if (records.size > 1_000) prune(now);
      const r = recordFor(`${roomId}:${userId}`);

      if (now < r.mutedUntil) return mutedVerdict(r.mutedUntil - now);

      const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
      const sentAt = r.sentAt.filter((at) => now - at < rules.floodWindowMs);
      const flood = sentAt.length >= rules.floodLimit;
      const sameRun =
        normalized === r.lastText && now - r.lastTextAt < rules.repeatWindowMs ? r.lastTextCount + 1 : 1;
      const repeat = sameRun >= rules.repeatLimit;
      const profane = !flood && !repeat && isProfane(text);

      if (flood || repeat || profane) {
        r.offenses = r.offenses.filter((at) => now - at < rules.offenseWindowMs);
        r.offenses.push(now);
        if (r.offenses.length >= rules.offensesToMute) {
          r.offenses = [];
          r.mutedUntil = now + rules.muteMs;
          return mutedVerdict(rules.muteMs);
        }
        const warning = `Sekali lagi kamu dibisukan ${minutesText(rules.muteMs)}.`;
        return profane
          ? { ok: false, code: CHAT_PROFANITY, message: `Pesanmu tidak dikirim karena mengandung kata kasar. ${warning}` }
          : { ok: false, code: CHAT_SLOW_DOWN, message: `Pelan-pelan ya, pesanmu tidak dikirim. ${warning}` };
      }

      sentAt.push(now);
      r.sentAt = sentAt;
      r.lastText = normalized;
      r.lastTextCount = sameRun;
      r.lastTextAt = now;
      return { ok: true };
    },
  };
}
