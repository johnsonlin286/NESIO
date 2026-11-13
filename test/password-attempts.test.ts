import { afterEach, describe, expect, it } from "vitest";
import { FailedAttemptLimiter } from "../src/lib/attempt-limiter.js";
import { call, cleanup, connect, ok, startServer } from "./helpers.js";

afterEach(cleanup);

describe("percobaan password room", () => {
  it("5 password salah: room terkunci untuk alamat itu, walau password berikutnya benar", async () => {
    const { url } = await startServer();
    const host = await connect(url, { name: "Pemilik" });
    const guest = await connect(url, { name: "Penebak" });
    const room = await ok<{ id: string }>(host, "room:create", { type: "abc-words", isPublic: true, password: "rahasia" });

    for (let i = 0; i < 5; i++) {
      expect(await call(guest, "room:join", { roomId: room.id, password: `salah${i}` })).toMatchObject({
        ok: false,
        error: { code: "INVALID_PASSWORD" },
      });
    }
    expect(await call(guest, "room:join", { roomId: room.id, password: "rahasia" })).toMatchObject({
      ok: false,
      error: { code: "TOO_MANY_ATTEMPTS" },
    });
  });

  it("limiter: kunci berakhir setelah waktunya, dan berhasil menghapus catatan", () => {
    const limiter = new FailedAttemptLimiter(3, 1_000, 5_000);
    limiter.recordFailure("k", 0);
    limiter.recordFailure("k", 100);
    limiter.recordSuccess("k");
    limiter.recordFailure("k", 200);
    expect(limiter.lockedFor("k", 300)).toBe(0); // catatan lama sudah dihapus

    limiter.recordFailure("k", 400);
    limiter.recordFailure("k", 500); // ke-3 dalam 1 detik
    expect(limiter.lockedFor("k", 600)).toBe(4_900);
    expect(limiter.lockedFor("k", 5_600)).toBe(0);
    expect(limiter.lockedFor("lain", 600)).toBe(0);
  });
});
