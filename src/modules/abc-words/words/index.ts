/**
 * Daftar jawaban terverifikasi per kategori (dibuat oleh scripts/word-lists/*.ts).
 * Jawaban yang ada di daftar langsung lolos dan tidak bisa ditolak; yang tidak ada tetap
 * boleh, lewat voting seperti biasa. Kategori tanpa daftar (mis. "custom") selalu lewat voting.
 */
import negara from "./negara.json" with { type: "json" };

const LISTS: Readonly<Record<string, ReadonlySet<string>>> = {
  negara: new Set(negara.words),
};

/** Kategori yang punya daftar jawaban terverifikasi. */
export const VERIFIED_CATEGORIES = Object.keys(LISTS);

/** `key` adalah kunci jawaban (lihat `answerKey`). */
export function isVerifiedAnswer(category: string, key: string): boolean {
  return LISTS[category]?.has(key) ?? false;
}
