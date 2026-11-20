import { Profanity } from "@2toad/profanity";
import { Badwords, dictionary, expandedDictionary } from "indonesian-badwords";
import { boundedEvasion, latinLookalikes } from "indonesian-badwords/evasion";

/**
 * Pemeriksa kata kasar untuk chat: bahasa Indonesia (termasuk kosakata daerah) lewat
 * `indonesian-badwords`, dan bahasa Inggris lewat `@2toad/profanity`.
 * Kamus dimuat sekali saja; satu pemeriksaan hanya butuh mikrodetik.
 *
 * Kamus Indonesia yang dipakai adalah versi "expanded": kamus bawaan ditambah kata yang juga
 * punya arti sehari-hari tapi sering dipakai untuk mengumpat atau merundung ("anjing", "babi",
 * "monyet", "sampah", "noob"). Pilihan pemilik game: lebih baik sesekali menolak pesan wajar
 * daripada membiarkan perundungan verbal di chat. Dipakai untuk chat dan nama pemain; jawaban
 * memakai kamus dasar (`strict: false`), lihat `ProfanityCheckerOptions`.
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

/** Akhiran yang sering ditempel ke kata kasar ("kontolnya", "memekmu"). */
const SUFFIXES = ["nya", "mu", "ku", "lah", "kah", "pun"];

/**
 * Kata kasar sependek ini tidak dicari sebagai awalan kata lain: "tai" ada di awal "taipan" (ular),
 * "bego" di awal "begonia". Yang 5 huruf ke atas jarang jadi awalan kata wajar (diuji ke semua
 * daftar kata kategori di `test/chat-profanity.test.ts`).
 */
export const MIN_PREFIX_LENGTH = 5;

/**
 * Kata kamus dasar 5 huruf ke atas yang tetap tidak dicari sebagai awalan, karena awal dari kata
 * wajar: "kentu" (kentungan), "nying" (nyingkir), atau seruan ringan ("buset", "bujug").
 */
const NOT_PREFIXES = new Set(["kentu", "nying", "buset", "bujug"]);

/** Kata-kata huruf dari teks yang sudah dinormalkan, untuk pemeriksaan akhiran dan awalan. */
const wordsOf = (text: string) => normalizeForMatching(text).split(/[^\p{L}]+/u).filter(Boolean);

export interface ProfanityChecker {
  /** `true` kalau teks mengandung kata kasar dalam salah satu bahasa yang dikenal. */
  isProfane(text: string): boolean;
}

export interface ProfanityCheckerOptions {
  /**
   * `true` (default): kamus Indonesia "expanded", untuk chat dan nama pemain, yang juga menolak
   * kata sehari-hari yang sering dipakai mengumpat ("anjing", "babi", "monyet").
   * `false`: kamus dasar, untuk jawaban, supaya "Anjing" dan "Babi" tetap bisa dijawab di Hewan.
   */
  strict?: boolean;
  extraAllowed?: string[];
}

export function createProfanityChecker({ strict = true, extraAllowed = [] }: ProfanityCheckerOptions = {}): ProfanityChecker {
  const allowed = [...ALLOWED_WORDS, ...extraAllowed];

  const indonesian = new Badwords({
    dictionary: strict ? expandedDictionary : dictionary,
    allowPhrases: allowed,
    // Menangkap "g-o-b-l-o-k", "gooooblok" dan huruf yang mirip; tanpa fuzzy matching, karena itu
    // ikut menandai kata biasa seperti "kontrol" atau "bangsa".
    evasion: boundedEvasion({
      separators: { characters: [" ", ".", "_", "-"], maxGap: 1, maxTotal: 8 },
      repetitions: { maxExtraPerLetter: 4, maxTotal: 12 },
      confusables: { mappings: latinLookalikes, maxTotal: 2 },
    }),
  });

  // Awalan hanya dari kamus dasar, juga untuk mode ketat: kata tambahan di kamus "expanded" sering jadi
  // awal kata wajar ("jaran" -> jarang, "konti" -> kontinu, "pante" -> pantes). Kamus juga memuat frasa
  // ("anak haram"); awalan hanya dicari untuk kata tunggal.
  const prefixes = new Set<string>(
    dictionary.filter((w) => w.length >= MIN_PREFIX_LENGTH && /^\p{L}+$/u.test(w) && !NOT_PREFIXES.has(w)),
  );
  const longestPrefix = Math.max(...[...prefixes].map((w) => w.length));
  const startsWithBadWord = (word: string) => {
    for (let n = MIN_PREFIX_LENGTH; n <= Math.min(word.length, longestPrefix); n++) {
      if (prefixes.has(word.slice(0, n))) return true;
    }
    return false;
  };

  const english = new Profanity({ languages: ["en"], wholeWord: true, unicodeWordBoundaries: true });
  if (allowed.length > 0) english.whitelist.addWords(allowed);
  const allowedWords = new Set(allowed.map((w) => w.toLowerCase()));

  const flagsWholeWord = (text: string) => indonesian.flag(text) || english.exists(normalizeForMatching(text));

  return {
    isProfane(text) {
      if (flagsWholeWord(text)) return true;
      // Kamus hanya mencocokkan kata utuh, jadi "kontolnya" dan "kontolx" lolos. Dua pemeriksaan tambahan
      // per kata: (A) akhiran umum dibuang lalu dicek lagi, (B) kata yang diawali kata kasar panjang.
      return wordsOf(text).some((word) => {
        if (allowedWords.has(word)) return false;
        const stripped = SUFFIXES.filter((s) => word.length - s.length >= 3 && word.endsWith(s)).map((s) => word.slice(0, -s.length));
        return stripped.some(flagsWholeWord) || startsWithBadWord(word);
      });
    },
  };
}
