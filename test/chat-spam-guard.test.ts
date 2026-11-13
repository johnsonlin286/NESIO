import { describe, expect, it } from "vitest";
import {
  CHAT_MUTED,
  CHAT_SLOW_DOWN,
  DEFAULT_CHAT_SPAM_RULES,
  createChatSpamGuard,
} from "../src/modules/chat/spam-guard.js";

const MUTE = DEFAULT_CHAT_SPAM_RULES.muteMs;

describe("chat spam guard", () => {
  it("pesan biasa lolos", () => {
    const guard = createChatSpamGuard();
    expect(guard.check("R", "u", "halo", 0)).toEqual({ ok: true });
    expect(guard.check("R", "u", "apa kabar", 3_000)).toEqual({ ok: true });
  });

  it("pesan sama 2 kali boleh, ke-3 berturut-turut ditolak", () => {
    const guard = createChatSpamGuard();
    expect(guard.check("R", "u", "wkwk", 0).ok).toBe(true);
    expect(guard.check("R", "u", "WKWK ", 2_000).ok).toBe(true);
    expect(guard.check("R", "u", "wkwk", 4_000)).toMatchObject({ ok: false, code: CHAT_SLOW_DOWN });
  });

  it("pesan sama yang berjarak lama, atau diselingi pesan lain, tidak dihitung", () => {
    const guard = createChatSpamGuard();
    guard.check("R", "u", "gg", 0);
    guard.check("R", "u", "gg", 1_000);
    expect(guard.check("R", "u", "gg", 40_000).ok).toBe(true); // lewat 30 detik
    guard.check("R", "u", "lain", 41_000);
    expect(guard.check("R", "u", "gg", 42_000).ok).toBe(true);
  });

  it("lebih dari 5 pesan dalam 10 detik ditolak", () => {
    const guard = createChatSpamGuard();
    for (let i = 0; i < 5; i++) expect(guard.check("R", "u", `pesan ${i}`, i * 1_000).ok).toBe(true);
    expect(guard.check("R", "u", "pesan 5", 5_000)).toMatchObject({ ok: false, code: CHAT_SLOW_DOWN });
    expect(guard.check("R", "u", "pesan 6", 11_000).ok).toBe(true); // jendela sudah bergeser
  });

  it("pelanggaran ke-2 dalam 10 menit: dibisukan 2 menit, lalu bisa kirim lagi", () => {
    const guard = createChatSpamGuard();
    for (let i = 0; i < 3; i++) guard.check("R", "u", "spam", i * 100); // pelanggaran 1 di pesan ke-3
    const muted = guard.check("R", "u", "spam", 400); // pelanggaran 2
    expect(muted).toEqual({ ok: false, code: CHAT_MUTED, message: expect.any(String), retryAfterMs: MUTE });

    const during = guard.check("R", "u", "halo", 400 + 60_000);
    expect(during).toMatchObject({ ok: false, code: CHAT_MUTED, retryAfterMs: MUTE - 60_000 });

    expect(guard.check("R", "u", "halo", 400 + MUTE).ok).toBe(true);
  });

  it("pelanggaran yang lebih dari 10 menit lalu terlupakan", () => {
    const guard = createChatSpamGuard();
    for (let i = 0; i < 3; i++) guard.check("R", "u", "spam", i * 100);
    const later = 11 * 60_000;
    for (let i = 0; i < 2; i++) guard.check("R", "u", "spam", later + i * 100);
    expect(guard.check("R", "u", "spam", later + 200)).toMatchObject({ ok: false, code: CHAT_SLOW_DOWN });
  });

  it("pemain dan room lain tidak terpengaruh", () => {
    const guard = createChatSpamGuard();
    for (let i = 0; i < 4; i++) guard.check("R", "u", "spam", i * 100);
    expect(guard.check("R", "u", "x", 500)).toMatchObject({ ok: false, code: CHAT_MUTED });
    expect(guard.check("R", "other", "spam", 500).ok).toBe(true);
    expect(guard.check("R2", "u", "spam", 500).ok).toBe(true);
  });
});
