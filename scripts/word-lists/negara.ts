/**
 * Membuat daftar jawaban "Negara" yang terverifikasi:
 *   npx tsx scripts/word-lists/negara.ts
 *
 * Sumber: data Unicode CLDR yang sudah dibawa Node.js (`Intl.DisplayNames`), nama bahasa Indonesia
 * saja (jawaban harus berbahasa Indonesia), untuk 193 anggota PBB + Vatikan, Palestina, Taiwan dan Kosovo, ditambah alias populer
 * yang tidak ada di CLDR. Hasilnya `src/modules/abc-words/words/negara.json`: kunci jawaban
 * (lihat `answerKey`), urut dan unik. Jawaban yang tidak ada di daftar tetap boleh, tapi lewat voting.
 */
import { toKeys, writeWordList } from "./shared.js";

/** ISO 3166-1 alpha-2 untuk 193 anggota PBB. */
const UN_MEMBERS = `
AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA
CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE
DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR KW KG LA LV LB
LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG
MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO
ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW
`.trim().split(/\s+/);

/** Pengamat PBB dan negara yang diakui sebagian, yang umum dianggap "negara" oleh pemain. */
const OTHERS = ["VA", "PS", "TW", "XK"];

/**
 * Jawaban hanya dalam bahasa Indonesia. Nama CLDR (bahasa Indonesia) yang perlu diganti, karena
 * tidak lazim diketik orang.
 */
const OVERRIDES: Record<string, string> = {
  PS: "Palestina", // CLDR: "Wilayah Palestina"
  CI: "Pantai Gading", // CLDR: "Côte d’Ivoire"
  MM: "Myanmar", // CLDR: "Myanmar (Burma)"; Burma is English
};

/** Nama lain dalam bahasa Indonesia yang umum dipakai dan tidak ada di CLDR. */
const ALIASES: Record<string, string[]> = {
  US: ["Amerika", "AS"],
  GB: ["Inggris", "Britania Raya"],
  CN: ["Cina", "RRC"],
  KR: ["Korsel", "Korea"],
  KP: ["Korut"],
  CZ: ["Republik Ceko"],
  CD: ["Republik Demokratik Kongo", "Kongo"],
  CG: ["Republik Kongo", "Kongo"],
  TR: ["Turkiye"],
  AE: ["UEA", "Emirat Arab"],
  MK: ["Makedonia"],
  TL: ["Timor Timur"],
  BA: ["Bosnia"],
  PG: ["Papua Nugini"],
  DO: ["Dominika"],
  SA: ["Saudi"],
  NZ: ["Selandia Baru"],
  // Spellings Indonesian media use next to CLDR's (Cile, Rumania, Afganistan, Brunei).
  CL: ["Chili"],
  RO: ["Romania"],
  AF: ["Afghanistan"],
  BN: ["Brunei Darussalam"],
};

const codes = [...UN_MEMBERS, ...OTHERS];
if (UN_MEMBERS.length !== 193 || new Set(codes).size !== codes.length) {
  throw new Error(`Daftar kode tidak valid: ${UN_MEMBERS.length} anggota PBB, ${codes.length} kode`);
}

const id = new Intl.DisplayNames(["id"], { type: "region", fallback: "none" });

const keys = new Set<string>();
/** Negara mana saja yang memakai sebuah kunci; "kongo" dipakai dua negara. */
const codesOf = new Map<string, Set<string>>();
/** Nama utama (nama CLDR/override) tiap negara. */
const mainKey = new Map<string, string>();
for (const code of codes) {
  const name = OVERRIDES[code] ?? id.of(code);
  if (!name) throw new Error(`Tidak ada nama CLDR untuk ${code}`);
  mainKey.set(code, toKeys(name)[0]!);
  const labels = [name, ...(ALIASES[code] ?? [])];
  for (const label of labels) {
    for (const key of toKeys(label!)) {
      keys.add(key);
      codesOf.set(key, (codesOf.get(key) ?? new Set()).add(code));
    }
  }
}

// Nama lain dari negara yang sama dihitung jawaban kembar ("Amerika" = "Amerika Serikat" = "AS").
// Kunci yang dipakai lebih dari satu negara ("kongo") tidak dipetakan: tidak jelas negara yang mana.
const same: Record<string, string> = {};
for (const [key, owners] of codesOf) {
  if (owners.size !== 1) continue;
  const main = mainKey.get([...owners][0]!)!;
  if (key !== main) same[key] = main;
}
console.log(`nama lain: ${Object.entries(same).map(([k, v]) => `${k}=${v}`).join(", ")}`);

writeWordList("negara", {
  source: `Unicode CLDR ${process.versions.cldr} via Node.js Intl.DisplayNames (id) + manual overrides and aliases`,
  license: "Unicode License v3 (CLDR); aliases written for this project",
  words: [...keys],
  same,
});
