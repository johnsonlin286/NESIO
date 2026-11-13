import { Profanity } from "@2toad/profanity";
import { Badwords, expandedDictionary } from "indonesian-badwords";
import { boundedEvasion, latinLookalikes } from "indonesian-badwords/evasion";

/**
 * Pemeriksa kata kasar untuk chat: bahasa Indonesia (termasuk kosakata daerah) lewat
 * `indonesian-badwords`, dan bahasa Inggris lewat `@2toad/profanity`.
 * Kamus dimuat sekali saja; satu pemeriksaan hanya butuh mikrodetik.
 *
 * Kamus Indonesia yang dipakai adalah versi "expanded": kamus bawaan ditambah kata yang juga
 * punya arti sehari-hari tapi sering dipakai untuk mengumpat atau merundung ("anjing", "babi",
 * "monyet", "sampah", "noob"). Pilihan pemilik game: lebih baik sesekali menolak pesan wajar
 * daripada membiarkan perundungan verbal di chat. Ini hanya berlaku untuk chat, bukan jawaban.
 *
 * Semua kata kasar diperlakukan sama: tidak ada tingkat keparahan (keputusan pemilik game).
 *
 * Kamus bahasa lain dari `@2toad/profanity` sengaja tidak dipakai: isinya terjemahan mesin yang
 * memuat kata biasa ("ya" dan "ku" di kamus Mandarin; "les", "bar", "bolo", "no" di kamus Eropa)
 * yang akan menolak obrolan bahasa Indonesia yang wajar.
 */

/**
 * Kata yang wajar di game ini atau dalam obrolan bahasa Indonesia, tapi tercatat sebagai kata kasar
 * di salah satu kamus bahasa lain. Tambahkan di sini kalau ada laporan salah tangkap.
 */
const ALLOWED_WORDS: string[] = [];

/** Angka dan simbol yang sering dipakai untuk menyamarkan huruf. */
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
};

/**
 * Bentuk teks yang dicek kamus bahasa lain (`indonesian-badwords` menormalkan sendiri):
 * huruf kecil tanpa aksen, angka/simbol pengganti huruf dikembalikan, huruf yang diulang lebih
 * dari dua kali dipadatkan, dan huruf tunggal yang dipisah titik/spasi/strip digabung lagi
 * ("f.u.c.k" -> "fuck").
 */
export function normalizeForMatching(text: string): string {
  const lowered = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[0-9@$!]/g, (ch) => LEET[ch] ?? ch)
    .replace(/(\p{L})\1{2,}/gu, "$1$1");
  // Rangkaian huruf tunggal yang dipisah pemisah: "a n j i n g", "f.u.c.k", "s-h-i-t".
  return lowered.replace(/\b(?:\p{L}[\s._-]){2,}\p{L}\b/gu, (run) => run.replace(/[\s._-]/g, ""));
}

export interface ProfanityChecker {
  /** `true` kalau teks mengandung kata kasar dalam salah satu bahasa yang dikenal. */
  isProfane(text: string): boolean;
}

export function createProfanityChecker(extraAllowed: string[] = []): ProfanityChecker {
  const allowed = [...ALLOWED_WORDS, ...extraAllowed];

  const indonesian = new Badwords({
    dictionary: expandedDictionary,
    allowPhrases: allowed,
    // Menangkap "g-o-b-l-o-k", "gooooblok" dan huruf yang mirip; tanpa fuzzy matching, karena itu
    // ikut menandai kata biasa seperti "kontrol" atau "bangsa".
    evasion: boundedEvasion({
      separators: { characters: [" ", ".", "_", "-"], maxGap: 1, maxTotal: 8 },
      repetitions: { maxExtraPerLetter: 4, maxTotal: 12 },
      confusables: { mappings: latinLookalikes, maxTotal: 2 },
    }),
  });

  const english = new Profanity({ languages: ["en"], wholeWord: true, unicodeWordBoundaries: true });
  if (allowed.length > 0) english.whitelist.addWords(allowed);


  return {
    isProfane(text) {
      if (indonesian.flag(text)) return true;
      return english.exists(normalizeForMatching(text));
    },
  };
}
