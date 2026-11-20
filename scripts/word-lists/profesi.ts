/**
 * Membuat daftar jawaban "Profesi" yang terverifikasi:
 *   npx tsx scripts/word-lists/profesi.ts
 *
 * Sumber: daftar yang ditulis untuk proyek ini. Aturannya (keputusan pemilik): hanya profesi
 * SATU kata, nama dasarnya. "Dokter" terverifikasi; "Dokter Gigi", "Dokter Bedah" lewat voting.
 * Profesi dua kata berawalan juru/kepala/ahli/pemandu/penjaga/pegawai/anggota tidak dimasukkan;
 * yang punya padanan satu kata memakai padanannya (juru masak -> koki, ahli gizi -> nutrisionis,
 * pemandu wisata -> pramuwisata). Hanya `TWO_WORDS` yang dua kata: tidak ada padanan satu katanya.
 * Kata serapan yang ada di KBBI boleh walau ejaannya sama dengan bahasa Inggris (editor, legislator,
 * senator, nutrisionis); kata bahasa Inggris yang belum diserap tidak (chef, bartender).
 * "Programer" dan bentuk bakunya "pemrogram" sama-sama diterima.
 */
import { toKeys, withJoined, writeWordList } from "./shared.js";

const PROFESI = `
  advokat agen ajudan akuntan aktor aktris animator apoteker arkeolog arsitek astronaut astronom atlet auditor
  badut bankir barista bendahara bidan binaragawan buruh bupati
  camat cerpenis
  dalang dekan desainer detektif diplomat direktur dirigen dokter dosen
  editor ekonom
  farmasis filsuf fisikawan fisioterapis fotografer
  gembala geolog gitaris gubernur guru
  hakim
  ilmuwan ilustrator insinyur instruktur investor
  jagal jaksa jenderal joki juri jurnalis
  kamerawan kapten karyawan kartunis kasir kiai koki kolonel komedian komposer kondektur konsultan kontraktor
  koreografer kritikus kuli kurator kurir kusir
  laksamana legislator lurah
  makelar manajer mandor marinir masinis matematikawan mekanik menteri model montir motivator musisi
  nakhoda nelayan notaris novelis nutrisionis
  operator optometris
  pedagang pegawai pelatih pelaut pelukis pemahat pembalap pemulung penari penambang penerjemah peneliti
  pemrogram pengacara pengamen pengusaha penjahit penulis penyair penyanyi penyiar perajin perawat peternak petani
  petinju pialang pilot polisi politikus pramugara pramugari pramuniaga pramusaji pramuwisata presiden
  produser profesor programer psikiater psikolog pustakawan
  rektor reporter resepsionis
  satpam sejarawan sekretaris seniman senator sinden sipir sopir sosiolog sutradara
  tabib teknisi tentara terapis tukang
  ustaz usahawan
  vokalis
  wartawan wasit wiraniaga wiraswasta
`
  .trim()
  .split(/\s+/);

/** Satu-satunya profesi dua kata: tidak ada padanan satu katanya (juga diterima ditulis gabung). */
const TWO_WORDS = ["pemadam kebakaran", "ibu rumah tangga", "wali kota"];

const words = new Set<string>();
for (const word of PROFESI) for (const key of toKeys(word)) words.add(key);
if ([...words].some((w) => w.includes(" "))) throw new Error("PROFESI harus satu kata; profesi dua kata masuk TWO_WORDS");
for (const word of TWO_WORDS) for (const key of withJoined(toKeys(word))) words.add(key);

writeWordList("profesi", {
  source: "Common single-word Indonesian profession names written for this project",
  license: "Written for this project",
  words: [...words],
});
