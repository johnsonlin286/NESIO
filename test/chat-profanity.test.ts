import { describe, expect, it } from "vitest";
import { createProfanityChecker, normalizeForMatching } from "../src/modules/chat/profanity.js";
import { CHAT_MUTED, CHAT_PROFANITY, CHAT_SLOW_DOWN, createChatSpamGuard } from "../src/modules/chat/spam-guard.js";

const checker = createProfanityChecker();

describe("filter kata kasar", () => {
  it.each([
    "dasar goblok",
    "g0bl0k lu",
    "g-o-b-l-o-k",
    "GOOOOBLOK",
    "bangsat",
    "jancuk", // Jawa
    "fuck you",
    "f.u.c.k",
    "sh1t happens",
    "you bitch",
    // Kamus "expanded": kata sehari-hari yang sering dipakai merundung.
    "anjing lu",
    "dasar babi",
    "asu",
    "monyet kau",
    "sampah",
  ])("menangkap: %s", (text) => {
    expect(checker.isProfane(text)).toBe(true);
  });

  it.each([
    "terima kasih",
    "sabar ya", // "ya" ada di kamus Mandarin hasil terjemahan mesin; tidak dipakai
    "kontrol diri",
    "bangsa indonesia",
    "kampung halaman",
    "les piano", // "les" di kamus Prancis
    "ke bar dulu", // "bar" di kamus Portugis
    "assessment",
    "class",
    "mantap jiwa",
    "wkwkwk gg",
    "kopi susu",
    "kucing", // nama hewan lain tetap aman
    "ayo main lagi",
  ])("tidak menangkap: %s", (text) => {
    expect(checker.isProfane(text)).toBe(false);
  });

  it("normalisasi: huruf samaran, huruf berulang, huruf yang dipisah", () => {
    expect(normalizeForMatching("Sh1t")).toBe("shit");
    expect(normalizeForMatching("fuuuuck")).toBe("fuuck");
    expect(normalizeForMatching("f.u.c.k off")).toBe("fuck off");
  });
});

describe("chat guard: kata kasar", () => {
  const guard = () => createChatSpamGuard(undefined, (text) => checker.isProfane(text));

  it("pesan berisi kata kasar ditolak dan tidak dicatat sebagai terkirim", () => {
    const g = guard();
    expect(g.check("R", "u", "dasar goblok", 0)).toMatchObject({ ok: false, code: CHAT_PROFANITY });
    expect(g.check("R", "u", "maaf ya", 1_000).ok).toBe(true);
  });

  it("kata kasar kedua: dibisukan", () => {
    const g = guard();
    g.check("R", "u", "dasar goblok", 0);
    expect(g.check("R", "u", "bangsat", 1_000)).toMatchObject({ ok: false, code: CHAT_MUTED });
  });

  it("spam dan kata kasar dihitung bersama", () => {
    const g = guard();
    g.check("R", "u", "wkwk", 0);
    g.check("R", "u", "wkwk", 100);
    expect(g.check("R", "u", "wkwk", 200)).toMatchObject({ ok: false, code: CHAT_SLOW_DOWN });
    expect(g.check("R", "u", "dasar goblok", 300)).toMatchObject({ ok: false, code: CHAT_MUTED });
  });
});
