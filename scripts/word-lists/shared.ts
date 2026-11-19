/** Helpers shared by the word-list scripts in this folder. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_MAX, ANSWER_MIN, answerKey } from "../../src/modules/abc-words/index.js";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/modules/abc-words/words");

/**
 * Every answer key a label can be typed as. Players can only type letters and spaces, so:
 * "Myanmar (Burma)" -> "myanmar", "burma"; "St. Kitts & Nevis" -> "saint kitts dan nevis",
 * "st kitts nevis" (answers are Indonesian, so "&" becomes "dan"); "Côte d’Ivoire" -> "cote d ivoire", "cote divoire".
 */
export function toKeys(label: string): string[] {
  // "Myanmar (Burma)": the two names, never both together.
  const bracket = label.match(/^(.*?)\s*\((.*)\)\s*$/);
  const variants = new Set<string>(bracket ? [bracket[1]!, bracket[2]!] : [label]);
  // Twice, so the rewrites combine ("St. Kitts & Nevis" -> "Saint Kitts dan Nevis").
  for (let pass = 0; pass < 2; pass++) {
    for (const v of [...variants]) {
      if (v.includes("&")) variants.add(v.replace(/&/g, " dan "));
      if (/\bSt\.? /.test(v)) variants.add(v.replace(/\bSt\.? /g, "Saint "));
      // Apostrophes: "d’Ivoire" can be typed with or without a space.
      if (/['’]/.test(v)) variants.add(v.replace(/['’]/g, ""));
    }
  }
  const keys = new Set<string>();
  for (const v of variants) {
    const cleaned = v
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^A-Za-z]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
    const key = answerKey(cleaned);
    if (key.length >= ANSWER_MIN && key.length <= ANSWER_MAX) keys.add(key);
  }
  return [...keys];
}

/** Indonesian names are often written as one word: "tanjung balai" also "tanjungbalai", "kura kura" also "kurakura". */
export function withJoined(keys: string[]): string[] {
  return keys.flatMap((k) => (k.includes(" ") ? [k, k.replace(/ /g, "")] : [k]));
}

/**
 * Only the base name is verified for kinds of things: "jambu biji", "ikan emas", "bawang merah" are dropped
 * (with their joined spelling) when "jambu", "ikan", "bawang" are in the list, so such answers go to
 * the vote. Kept: reduplications ("kura kura") and `keep`, names of something else entirely ("kuda nil").
 */
export function dropQualified(keys: Set<string>, keep: readonly string[] = []): string[] {
  const dropped: string[] = [];
  for (const key of [...keys]) {
    const words = key.split(" ");
    const reduplication = words.length === 2 && words[0] === words[1];
    if (words.length < 2 || reduplication || keep.includes(key) || !keys.has(words[0]!)) continue;
    keys.delete(key);
    keys.delete(key.replace(/ /g, ""));
    dropped.push(key);
  }
  return dropped;
}

/** Writes `words/<name>.json` (sorted, unique) and prints a short summary instead of the list. */
export function writeWordList(
  name: string,
  list: {
    source: string;
    license: string;
    words: string[];
    /** Other names of the same thing -> its main name ("amerika" -> "amerika serikat"), for duplicates. */
    same?: Record<string, string>;
  },
): void {
  const words = [...new Set(list.words)].sort();
  const same = list.same && Object.fromEntries(Object.entries(list.same).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, `${name}.json`);
  const json = { source: list.source, license: list.license, words, ...(same && { same }) };
  writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`);

  const byLetter = new Map<string, string[]>();
  for (const w of words) byLetter.set(w[0]!, [...(byLetter.get(w[0]!) ?? []), w]);
  const missing = [..."abcdefghijklmnopqrstuvwxyz"].filter((l) => !byLetter.has(l));
  console.log(`${name}: ${words.length} kunci -> ${file}`);
  console.log(`huruf tanpa jawaban: ${missing.join(" ").toUpperCase() || "-"}`);
  for (const [letter, ws] of byLetter) {
    console.log(`${letter.toUpperCase()} (${ws.length}): ${ws.slice(0, 6).join(", ")}${ws.length > 6 ? ", …" : ""}`);
  }
}
