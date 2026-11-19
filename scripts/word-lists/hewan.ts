/**
 * Membuat daftar jawaban "Hewan" yang terverifikasi:
 *   mkdir /tmp/wordnet && cd /tmp/wordnet
 *   curl -O https://raw.githubusercontent.com/omwn/omw-data/main/wns/msa/wn-data-ind.tab
 *   curl -O https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz && tar -xzf WNdb-3.0.tar.gz dict/data.noun
 *   npx tsx scripts/word-lists/hewan.ts /tmp/wordnet
 *
 * Dua sumber:
 * 1. Wordnet Bahasa (MIT, Francis Bond & David Moeljadi): kata Indonesia untuk setiap synset Princeton
 *    WordNet 3.0 yang ada di berkas leksikograf `noun.animal` (nomor 05 di data.noun). Hanya kata huruf
 *    kecil (nama Indonesia; yang berhuruf kapital umumnya nama Latin atau Inggris), dikurangi `EXCLUDE`:
 *    Wordnet Bahasa dibuat setengah otomatis, jadi ikut terbawa bagian tubuh, manusia, mikroba, dll.
 * 2. `COMMON`: hewan yang umum dijawab, ditulis untuk proyek ini (Wordnet Bahasa tidak lengkap,
 *    mis. "kecoa" tidak ada).
 * Kata ulang ("kura-kura") juga diterima tanpa tanda hubung: "kura kura" dan "kurakura".
 * Yang terverifikasi hanya nama dasar: "ikan emas", "ular kobra" lewat voting karena "ikan" dan "ular" ada
 * di daftar (lihat `dropQualified`), kecuali hewan lain sama sekali (`DIFFERENT_ANIMALS`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dropQualified, toKeys, withJoined, writeWordList } from "./shared.js";

const dir = process.argv[2];
if (!dir) throw new Error("Pakai: npx tsx scripts/word-lists/hewan.ts <folder berisi wn-data-ind.tab dan dict/data.noun>");

/** Kata dari Wordnet Bahasa yang bukan nama hewan (diperiksa satu per satu dari 606 kata). */
const EXCLUDE = new Set(
  `
  aerob agama alam-semesta alantois alga ambing ameba amnion ampela amuba anaerob anak api-api apung
  araknoid artropoda asad askar avertebrata baju-besi baka bakteri bakteriofag balung ban bangkai bangsat
  bari-bari basil basilus bastar bayi belalai benah benalu bendera benih benteng berenga bernga betina betis
  biadi biram binatang binatang-piaraan bulu bulu-kapas buruan cakar campuran cangkang capelin cepat cotok
  cula derik dewasa diatom diploid dukun dungu dunia duri ekor embrio endoderma endoparasit eukariota fetus
  foraminifera gading gambak gandik ganggang ganggang-hijau ganggang-laut ganggang-merah gaya genus gergasi
  gigi gombak gonggongan gumba halofili hama hangus herbivor herbivora herpes hibrida hominid induk insan
  insang invertebrata jambak jambu-jambu jambul janggut janin jantan jaringan jenazah jengger jumbai kacukan
  kaki kampang kangkang kanak-kanak kapak karier karkas karnivor kecil kelasa kepak kepala kerakap kerangka
  ketek kicauan klorofil kokus krustasea kuku kulit kulit-ari kulit-bulu kulit-kerang kuman kuning-telur
  laki-laki lambung lamun lapisan larva lelaki lembaga lingsa listeria lumut-laut lutut madu madukara mamalia
  mangsa manusia matang mayat merangkak-rangkak mikrob mikroba mikroorganisme misai mole monitor mua muda
  mudigah muka mulut muncung mutan naga nara nematoda omnivor orang parasit paruh patogen patung pawang pekan
  pekerja pelata pemakan pemangsa peneluran pengangkut penggiling pengimbang penyelam penyengat penyepit
  perasa perburuan perempuan perut pijat pinggul plankton plasmodium poikiloterm poliploid prajurit primer
  protista protozoa puncak pupa puting-susu ragum raksasa ratu reptilia rijal rumpun rusuk salmonela sampah
  sayap sekretariat selaput sengat sepit sera serangan serbuan sifon siku sirip sisik siung span
  streptokokus suari sumbu surai tanduk tangan taring telur telur-ikan tembolok tempurung tengkorak tengkuk
  tentakel tentera ternak torpedo trematoda tuan-rumah tulang tulang-belakang tunggangan umpan unggas
  unggas-air vektor vertebrata vibrio virus wali wanita wesel zib zoofit
  `
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/-/g, " ")),
);

/** Kata dasar + kata tambahan yang hewannya lain sama sekali dari kata dasarnya; tetap terverifikasi. */
const DIFFERENT_ANIMALS = ["kuda nil", "kuda laut", "anjing laut", "lembu laut", "dara laut", "burung unta"];

/** Hewan yang umum dijawab, per huruf; melengkapi Wordnet Bahasa. */
const COMMON = `
  alap-alap albatros aligator alpaka anakonda angsa anjing anoa antelop anemon-laut arwana armadilo ayam
  babi badak bandeng banteng bangau barakuda baung bebek bekantan bekicot belalang belibis belut beo
  beruang berang-berang biawak bintang-laut bison buaya bulu-babi bunglon burung burung-hantu burung-unta
  cacing camar capung cendrawasih celeng cerpelai cicak cucut cumi-cumi cupang curik citah codot
  domba dodo dugong duyung dara dingo dinosaurus
  elang emu enggang entok
  flamingo
  gabus gagak gajah gangsir garangan gelatik gibon gnu gorila gurami gurita
  hamster harimau hering hiena hiu
  iguana ikan impala itik
  jaguar jalak jangkrik jerapah julang
  kakak-tua kakatua kakap kalajengking kalkun kambing kancil kanguru kasuari katak kecoa kecoak kelelawar
  kelinci kembung kenari kepik kepiting kera kerang kerapu kerbau kijang koala kodok kolibri komodo kuda
  kuda-laut kuda-nil kukang kumbang kunang-kunang kupu-kupu kura-kura kuskus kutilang kutu
  laba-laba lalat landak lebah lele lemur lemuru lintah lipan lobster lumba-lumba lutung lama
  macan maleo mamut mandril marmut mencit merak merpati monyet mujair musang
  ngengat nila nuri nyamuk
  okapi onta orang-utan orang-hutan
  panda paus pari pelikan penguin pinguin penyu perkutut pesut piranha platipus puma puyuh pipit
  rajawali rajungan rakun rangkong rayap rubah rusa
  salmon sapi sarden sembilang semut sepat serangga serigala siamang sidat sigung simpanse singa siput
  soang sotong sriti
  tapir tarsius tawes tawon tekukur tenggiri teri tikus tiram tokek tongkol trenggiling tuna tungau tupai
  ubur-ubur udang ular ulat unta undur-undur ungka
  walabi walet walrus wombat wereng
  yak yuyu
  zebra zebu
`
  .trim()
  .split(/\s+/);

// Synset hewan di Princeton WordNet 3.0: berkas leksikograf 05 = noun.animal.
const animalSynsets = new Set<string>();
for (const line of readFileSync(resolve(dir, "dict/data.noun"), "utf8").split("\n")) {
  if (/^\d{8} 05 /.test(line)) animalSynsets.add(`${line.slice(0, 8)}-n`);
}

const keys = new Set<string>();
let fromWordnet = 0;
for (const line of readFileSync(resolve(dir, "wn-data-ind.tab"), "utf8").split("\n")) {
  const [synset, type, lemma] = line.split("\t");
  if (type !== "ind:lemma" || !lemma || !animalSynsets.has(synset!) || lemma !== lemma.toLowerCase()) continue;
  const word = lemma.replace(/_/g, " ");
  if (EXCLUDE.has(word.replace(/-/g, " "))) continue;
  fromWordnet++;
  for (const key of withJoined(toKeys(word))) keys.add(key);
}
for (const word of COMMON) for (const key of withJoined(toKeys(word))) keys.add(key);
const dropped = dropQualified(keys, DIFFERENT_ANIMALS);
console.log(`Wordnet Bahasa: ${fromWordnet} lemma dipakai; daftar umum: ${COMMON.length}`);
console.log(`lewat voting (kata dasarnya ada): ${dropped.join(", ")}`);

writeWordList("hewan", {
  source:
    "Wordnet Bahasa (Indonesian lemmas of Princeton WordNet 3.0 noun.animal synsets, filtered) " +
    "+ common animal names written for this project",
  license: "MIT (Wordnet Bahasa, Francis Bond & David Moeljadi); WordNet 3.0 license (Princeton University)",
  words: [...keys],
});
