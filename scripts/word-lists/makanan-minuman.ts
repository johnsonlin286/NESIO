/**
 * Membuat daftar jawaban "Makanan & Minuman" yang terverifikasi:
 *   npx tsx scripts/word-lists/makanan-minuman.ts
 *
 * Sumber: daftar yang ditulis untuk proyek ini, fokus makanan dan minuman yang umum di Indonesia.
 * Aturannya sama dengan Profesi (keputusan pemilik): hanya nama SATU kata. Kata ulang ("gado-gado")
 * dihitung satu kata, dan diterima tanpa tanda hubung ("gado gado", "gadogado"). Nama dua kata
 * ("nasi goreng", "teh manis") lewat voting, kecuali `TWO_WORDS`: nama yang kata depannya tidak ada
 * di daftar dan tidak punya padanan satu kata (disetujui pemilik).
 * Buah dan sayur tidak dimasukkan: sudah ada kategori "Buah & Sayur", dan di sini lewat voting.
 * Minuman beralkohol tidak dimasukkan (game untuk semua umur).
 */
import { toKeys, withJoined, writeWordList } from "./shared.js";

const MAKANAN_MINUMAN = `
  abon agar-agar apem arem-arem asinan
  bacang bajigur bakmi bakpao bakpia bakso bakwan bandrek batagor bihun biskuit boba bolu bubur burger buras
  cakwe capcai cendol cilok cimol cireng cokelat coklat combro coto
  dawet dendeng dimsum dodol donat
  emping
  gado-gado getuk gorengan gudeg gulai
  hamburger
  jamu jenang jus
  kebab keju keripik kerupuk ketoprak ketupat klepon kolak kopi kroket kue kwetiau
  laksa lemang lemper lepet limun lodeh lontong lumpia
  makaroni martabak mendoan mi mie misoa mochi
  nagasari nasi nastar
  oncom onde-onde opor oseng-oseng otak-otak
  panekuk pastel pecel pempek pepes perkedel peyek pindang pizza puding pukis putu
  rawon rempeyek rendang rengginang risoles roti rujak
  sambal sate seblak sekoteng semur serabi siomay sirup sop sosis soto spageti sup susu
  tahu tapai tape teh tekwan telur tempe tiwul tongseng tumpeng
  urap
  wafer wajik wedang wingko
  yogurt
`
  .trim()
  .split(/\s+/);

/** Ejaan lain dari makanan yang sama -> ejaan utama: dihitung jawaban kembar di satu ronde. */
const SAME: Record<string, string> = {
  mie: "mi",
  tape: "tapai",
  sup: "sop",
  coklat: "cokelat",
  peyek: "rempeyek",
};

/** Dua kata yang disetujui: "es", "air", "ayam", "pisang", "bika" sendiri tidak ada di daftar ini. */
const TWO_WORDS = ["es krim", "es teh", "es campur", "air putih", "ayam goreng", "pisang goreng", "bika ambon"];

const words = new Set<string>();
for (const word of MAKANAN_MINUMAN) {
  const parts = word.split("-");
  // Satu kata, atau kata ulang ("gado-gado").
  if (parts.length > 1 && !parts.every((p) => p === parts[0])) throw new Error(`Bukan satu kata: ${word}`);
  for (const key of withJoined(toKeys(word))) words.add(key);
}
for (const word of TWO_WORDS) for (const key of withJoined(toKeys(word))) words.add(key);

writeWordList("makanan-minuman", {
  source: "Common single-word Indonesian food and drink names written for this project",
  license: "Written for this project",
  words: [...words],
  same: SAME,
});
