/**
 * Daftar jawaban terverifikasi per kategori (dibuat oleh scripts/word-lists/*.ts).
 * Jawaban yang ada di daftar langsung lolos dan tidak bisa ditolak; yang tidak ada tetap
 * boleh, lewat voting seperti biasa. Kategori tanpa daftar (mis. "custom") selalu lewat voting.
 */
import buahSayur from "./buah-sayur.json" with { type: "json" };
import hewan from "./hewan.json" with { type: "json" };
import kota from "./kota.json" with { type: "json" };
import makananMinuman from "./makanan-minuman.json" with { type: "json" };
import negara from "./negara.json" with { type: "json" };
import profesi from "./profesi.json" with { type: "json" };

const LISTS: Readonly<Record<string, ReadonlySet<string>>> = {
  negara: new Set(negara.words),
  kota: new Set(kota.words),
  hewan: new Set(hewan.words),
  "buah-sayur": new Set(buahSayur.words),
  profesi: new Set(profesi.words),
  "makanan-minuman": new Set(makananMinuman.words),
};

/** Kategori yang punya daftar jawaban terverifikasi. */
export const VERIFIED_CATEGORIES = Object.keys(LISTS);

/** Nama lain -> nama utama per kategori ("amerika" -> "amerika serikat"); dibuat oleh script daftarnya. */
const SAME: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  negara: negara.same,
  "makanan-minuman": makananMinuman.same,
};

/** `key` adalah kunci jawaban (lihat `answerKey`). */
export function isVerifiedAnswer(category: string, key: string): boolean {
  return LISTS[category]?.has(key) ?? false;
}

/**
 * Bentuk untuk mencari jawaban kembar: nama lain diganti nama utamanya, dan spasi diabaikan.
 * "Amerika", "AS" dan "Amerika Serikat" sama; "Tanjung Balai" sama dengan "Tanjungbalai".
 */
export function sameAnswerKey(category: string, key: string): string {
  return (SAME[category]?.[key] ?? key).replace(/ /g, "");
}

/**
 * Daftar yang menjadi bukti "bukan kategori": hampir tidak ada kata yang sama di antara daftar ini
 * (dicek 2026-11-28: Negara 0, Hewan–Buah & Sayur 1 kata, "kiwi"). Daftar Kota tidak termasuk:
 * 33 ribu nama tempat memuat banyak nama hewan dan buah (singa, kuda, pare, talas…).
 */
const EVIDENCE_LISTS = ["negara", "hewan", "buah-sayur", "profesi", "makanan-minuman"] as const;

/**
 * Kategori lain yang daftarnya memuat jawaban ini, kalau jawabannya tidak ada di daftar kategori ronde
 * ini: jawabannya gugur otomatis ("Jepang" di kategori Hewan). `null` untuk kategori tanpa daftar
 * ("Lainnya" tidak dicek sama sekali).
 */
export function otherCategoryOf(category: string, key: string): string | null {
  if (!LISTS[category] || isVerifiedAnswer(category, key)) return null;
  return EVIDENCE_LISTS.find((other) => other !== category && LISTS[other]!.has(key)) ?? null;
}

/**
 * Nama tempat yang dipakai sebagai jawaban di kategori lain ("Kendari" di kategori Hewan): bukti lemah,
 * karena banyak tempat bernama hewan atau buah. Jawabannya tetap dinilai pemain, tapi yang menolaknya
 * mendapat jatah tolaknya kembali walau jawabannya lolos.
 */
export function isPlaceName(category: string, key: string): boolean {
  if (!LISTS[category] || category === "kota" || isVerifiedAnswer(category, key)) return false;
  return LISTS.kota!.has(key);
}
