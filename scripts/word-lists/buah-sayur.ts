/**
 * Membuat daftar jawaban "Buah & Sayur" yang terverifikasi:
 *   npx tsx scripts/word-lists/buah-sayur.ts
 *
 * Sumber: daftar yang ditulis untuk proyek ini (buah dan sayur yang umum di Indonesia, nama bahasa
 * Indonesia beserta ejaan lain yang lazim). Jumlahnya terbatas, jadi tidak perlu sumber luar.
 * Bumbu dan rempah (jahe, kunyit) sengaja tidak dimasukkan; jawaban seperti itu lewat voting.
 * Nama dua kata juga diterima ditulis gabung, dan kata ulang tanpa tanda hubung ("lobi lobi").
 */
import { toKeys, withJoined, writeWordList } from "./shared.js";

const BUAH = `
  apel anggur alpukat avokad aprikot ara arbei belimbing belimbing-wuluh bisbul blewah buah-naga buni
  carica cempedak ceri ciplukan delima duku durian duwet jamblang frambos gandaria jambu jambu-air
  jambu-biji jambu-mete jambu-bol jeruk jeruk-bali jeruk-nipis jeruk-purut jeruk-mandarin jeruk-lemon
  kawista kecapi kedondong kelapa kelapa-muda kelengkeng lengkeng kepundung kersen kesemek kiwi kurma kweni
  langsat leci lemon lobi-lobi mangga manggis markisa matoa melon menteng mengkudu mundu nam-nam nanas nenas
  nangka pepaya persik pir pisang plum rambutan rukem salak sawo sawo-kecik semangka tembikai sentul sirsak
  sirsat srikaya stroberi stroberi-hutan sukun terong-belanda zaitun
`;

const SAYUR = `
  asparagus bawang bawang-merah bawang-putih bawang-bombai bayam bayam-merah bit brokoli buncis cabai cabe
  cabai-rawit cabe-rawit daun-bawang daun-katuk daun-kelor daun-pepaya daun-singkong edamame gambas genjer
  jagung jagung-muda jamur kailan kacang-panjang kacang-polong kacang-merah kangkung katuk kecipir kelor
  kembang-kol kentang kol kubis labu labu-siam lobak melinjo mentimun timun okra oyong pakcoy paprika pare
  peria petai pete rebung sawi sawi-hijau sawi-putih selada seledri singkong ketela ketela-pohon talas
  tauge taoge terong terung tomat ubi ubi-jalar wortel zukini
`;

const words = [...BUAH.trim().split(/\s+/), ...SAYUR.trim().split(/\s+/)];
const keys = new Set<string>();
for (const word of words) for (const key of withJoined(toKeys(word))) keys.add(key);
console.log(`daftar: ${words.length} nama`);

writeWordList("buah-sayur", {
  source: "Common Indonesian fruit and vegetable names written for this project",
  license: "Written for this project",
  words: [...keys],
});
