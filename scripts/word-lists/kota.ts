/**
 * Membuat daftar jawaban "Kota" yang terverifikasi:
 *   mkdir /tmp/geonames && cd /tmp/geonames
 *   curl -O https://download.geonames.org/export/dump/cities15000.zip && unzip cities15000.zip
 *   curl -O https://download.geonames.org/export/dump/admin2Codes.txt
 *   npx tsx scripts/word-lists/kota.ts /tmp/geonames
 *
 * Sumber: GeoNames (CC BY 4.0, wajib mencantumkan sumber):
 * - cities15000.txt: semua kota di dunia dengan penduduk di atas 15 ribu (kolom `name` dan `asciiname`);
 * - admin2Codes.txt: 514 kabupaten/kota di Indonesia ("Kota Bandung", "Kabupaten Garut" -> "bandung", "garut").
 * Jawaban harus berbahasa Indonesia, jadi kota yang punya nama Indonesia sendiri memakai nama itu
 * ("Roma", bukan "Rome"; lihat `EXONYMS`). Kota lain memakai nama aslinya (London, Tokyo).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toKeys, writeWordList } from "./shared.js";

const dir = process.argv[2];
if (!dir) throw new Error("Pakai: npx tsx scripts/word-lists/kota.ts <folder berisi cities15000.txt dan admin2Codes.txt>");

/** Nama GeoNames (Inggris) -> nama dalam bahasa Indonesia. Nama Inggrisnya tidak diterima. */
const EXONYMS: Record<string, string[]> = {
  Rome: ["Roma"],
  Moscow: ["Moskwa"],
  Vienna: ["Wina"],
  Prague: ["Praha"],
  Cairo: ["Kairo"],
  Jerusalem: ["Yerusalem"],
  "The Hague": ["Den Haag"],
  Warsaw: ["Warsawa"],
  Lisbon: ["Lisboa", "Lisabon"],
  Athens: ["Athena"],
  Copenhagen: ["Kopenhagen"],
  Brussels: ["Brussel"],
  Geneva: ["Jenewa"],
  Munich: ["Munchen"],
  Naples: ["Napoli"],
  Florence: ["Firenze"],
  Venice: ["Venesia"],
  Bucharest: ["Bukares"],
  Belgrade: ["Beograd"],
  Damascus: ["Damaskus"],
  Tehran: ["Teheran"],
  Algiers: ["Aljir"],
  "Mexico City": ["Kota Meksiko"],
  Medina: ["Madinah"],
  "Vatican City": ["Kota Vatikan", "Vatikan"],
};

/** Nama lain yang umum dipakai di Indonesia, ditambahkan begitu saja. */
const ALIASES = [
  "Mekkah",
  "Makkah",
  "Mekah",
  "Jogja",
  "Jogjakarta",
  "Yogya",
  "Solo",
  "Ujung Pandang",
];

const DIRECTIONS: Record<string, string> = {
  North: "Utara",
  South: "Selatan",
  East: "Timur",
  West: "Barat",
  Central: "Tengah",
};

/** "Kabupaten Garut" -> "Garut"; "South Tapanuli Regency" -> "Tapanuli Selatan"; "Selayar Islands Regency" -> "Kepulauan Selayar". */
function indonesianRegionName(name: string): string {
  let n = name.replace(/^(Kota|Kabupaten)\s+/, "").replace(/\s+(Regency|City)$/, "");
  const islands = n.match(/^(.*)\s+Islands$/);
  if (islands) n = `Kepulauan ${islands[1]}`;
  const direction = n.match(/^(North|South|East|West|Central)\s+(.*)$/);
  if (direction) n = `${direction[2]} ${DIRECTIONS[direction[1]!]}`;
  return n;
}

/** Nama Indonesia sering ditulis gabung: "Tanjung Balai" juga "tanjungbalai", dan sebaliknya. */
function withJoined(keys: string[]): string[] {
  return keys.flatMap((k) => (k.includes(" ") ? [k, k.replace(/ /g, "")] : [k]));
}

const keys = new Set<string>();
const excluded = new Set(
  Object.keys(EXONYMS).flatMap((name) => [...toKeys(name), ...toKeys(name.replace(/ City$/, ""))]),
);

// Kota dunia.
for (const line of readFileSync(resolve(dir, "cities15000.txt"), "utf8").split("\n")) {
  const cols = line.split("\t");
  if (cols.length < 15) continue;
  const [, name, asciiname] = cols;
  const country = cols[8];
  // "New York City", "Ho Chi Minh City": also without "City".
  const labels = [name!, asciiname!].flatMap((l) => (/ City$/.test(l) ? [l, l.replace(/ City$/, "")] : [l]));
  for (const label of labels) {
    const labelKeys = toKeys(label).filter((k) => !excluded.has(k));
    for (const key of country === "ID" ? withJoined(labelKeys) : labelKeys) keys.add(key);
  }
}

// Kabupaten/kota di Indonesia.
let regencies = 0;
for (const line of readFileSync(resolve(dir, "admin2Codes.txt"), "utf8").split("\n")) {
  const [code, name] = line.split("\t");
  if (!code?.startsWith("ID.") || !name) continue;
  regencies++;
  for (const key of withJoined(toKeys(indonesianRegionName(name)))) keys.add(key);
}
if (regencies !== 514) throw new Error(`Diharapkan 514 kabupaten/kota, ternyata ${regencies}`);

for (const label of [...Object.values(EXONYMS).flat(), ...ALIASES]) {
  for (const key of toKeys(label)) keys.add(key);
}

writeWordList("kota", {
  source:
    "GeoNames cities15000 (name, asciiname) + admin2Codes (Indonesian regencies and cities), " +
    "with Indonesian exonyms and aliases written for this project",
  license: "CC BY 4.0, GeoNames (https://www.geonames.org)",
  words: [...keys],
});
