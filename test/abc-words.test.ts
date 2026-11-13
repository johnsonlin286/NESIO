import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import {
  AFK_ROUNDS,
  createAbcWordsModule,
  drawLetter,
  type AbcWordsSettings,
  type AbcWordsState,
  type Reveal,
} from "../src/modules/abc-words/index.js";
import { createAbcWordsServer } from "../src/project/server.js";
import type { RoomSummary, RoomView } from "../src/shared/contract.js";
import { call, cleanup, connect, ok, sleep, startServer, waitFor } from "./helpers.js";

afterEach(cleanup);

/** Bentuk `state` yang diterima client (lihat `serializeState`). */
type ClientState = Omit<AbcWordsState, "picks" | "deadline"> & {
  remainingMs: number | null;
  pickedBy: string[];
  myPick: number | null;
  rejectionsLeft: number;
};
type GameRoom = RoomView<ClientState, AbcWordsSettings>;

async function setup() {
  const { url } = await startServer();
  const host = await connect(url, { name: "Host" });
  const guest = await connect(url, { name: "Tamu" });
  const room = await ok<GameRoom>(host, "room:create", { type: "abc-words", isPublic: true });
  await ok(guest, "room:join", { roomId: room.id });
  return { host, guest, room };
}

describe("abc-words: ruang tunggu", () => {
  it("room baru ada di fase waiting dengan konfigurasi bawaan", async () => {
    const { room } = await setup();
    expect(room.state.phase).toBe("waiting");
    expect(room.maxMembers).toBe(8);
    expect(room.settings).toMatchObject({ category: "bebas", customCategory: "", language: "id", maxRounds: 10 });
  });

  it("host mengubah konfigurasi dan pemain lain langsung menerimanya", async () => {
    const { host, guest } = await setup();
    const received = waitFor<GameRoom>(guest, "room:state", (r) => r.settings.category === "film");

    await ok(host, "room:update", { settings: { category: "film", language: "en", maxRounds: 5 } });

    expect((await received).settings).toMatchObject({ category: "film", language: "en", maxRounds: 5 });
  });

  it("perubahan sebagian tidak menghapus konfigurasi lain", async () => {
    const { host } = await setup();
    await ok(host, "room:update", { settings: { language: "en" } });
    const room = await ok<GameRoom>(host, "room:update", { settings: { maxRounds: 3 } });
    expect(room.settings).toMatchObject({ language: "en", maxRounds: 3 });
  });

  it("hanya host yang boleh mengubah konfigurasi", async () => {
    const { guest } = await setup();
    expect(await call(guest, "room:update", { settings: { maxRounds: 1 } })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
  });

  it.each([
    ["ronde lebih dari 10", { maxRounds: 11 }],
    ["ronde nol", { maxRounds: 0 }],
    ["bahasa tidak dikenal", { language: "fr" }],
    ["kategori tidak dikenal", { category: "makanan" }],
    ["kategori sendiri terlalu panjang", { customCategory: "x".repeat(41) }],
  ])("menolak %s", async (_label, settings) => {
    const { host } = await setup();
    expect(await call(host, "room:update", { settings })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("kategori sendiri dibersihkan dari karakter tak terlihat", async () => {
    const { host } = await setup();
    const room = await ok<GameRoom>(host, "room:update", {
      settings: { category: "custom", customCategory: "  Nama​   jajanan  " },
    });
    expect(room.settings.customCategory).toBe("Nama jajanan");
  });

  it("chat berjalan di dalam room game", async () => {
    const { host, guest } = await setup();
    const received = waitFor<{ event: string; data: { text: string } }>(
      guest,
      "room:event",
      (e) => e.event === "chat:message",
    );
    await ok(host, "room:action", { action: "send", payload: { text: "halo" } });
    expect((await received).data.text).toBe("halo");
  });
});

describe("abc-words: memulai permainan", () => {
  async function started() {
    const { url } = await startServer();
    const host = await connect(url, { name: "Host" });
    const guest = await connect(url, { name: "Tamu" });
    const room = await ok<GameRoom>(host, "room:create", { type: "abc-words", isPublic: true });
    await ok(guest, "room:join", { roomId: room.id });
    await ok(host, "room:action", { action: "start" });
    return { url, host, guest, room };
  }
  const listed = async (url: string, id: string) => {
    const body = (await (await fetch(`${url}/api/rooms`)).json()) as { data: RoomSummary[] };
    return body.data.find((r) => r.id === id)!;
  };

  it("host memulai: fase berubah, ronde 1, dan room terkunci di daftar lobby", async () => {
    const { url, host, room } = await started();
    const view = await ok<GameRoom>(host, "room:sync");
    expect(view.state).toMatchObject({ phase: "picking", round: 1 });
    expect((await listed(url, room.id)).locked).toBe(true);
  });

  it("pemain baru tidak bisa masuk saat permainan berjalan", async () => {
    const { url, room } = await started();
    const late = await connect(url, { name: "Telat" });
    expect(await call(late, "room:join", { roomId: room.id })).toMatchObject({
      ok: false,
      error: { code: "ROOM_LOCKED" },
    });
  });

  it("hanya host yang bisa memulai", async () => {
    const { guest, host } = await setup();
    expect(await call(guest, "room:action", { action: "start" })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    await ok(host, "room:action", { action: "start" });
  });

  it("butuh minimal 2 pemain", async () => {
    const { url } = await startServer();
    const host = await connect(url, { name: "Host" });
    await ok(host, "room:create", { type: "abc-words" });
    expect(await call(host, "room:action", { action: "start" })).toMatchObject({
      ok: false,
      error: { code: "NOT_ENOUGH_PLAYERS" },
    });
  });

  it("kategori sendiri harus ditulis dulu", async () => {
    const { host } = await setup();
    await ok(host, "room:update", { settings: { category: "custom" } });
    expect(await call(host, "room:action", { action: "start" })).toMatchObject({
      ok: false,
      error: { code: "CATEGORY_REQUIRED" },
    });
  });

  it("aturan main terkunci dan tidak bisa mulai dua kali saat permainan berjalan", async () => {
    const { host } = await started();
    expect(await call(host, "room:update", { settings: { maxRounds: 1 } })).toMatchObject({
      ok: false,
      error: { code: "GAME_RUNNING" },
    });
    expect(await call(host, "room:action", { action: "start" })).toMatchObject({
      ok: false,
      error: { code: "GAME_ALREADY_STARTED" },
    });
  });

  it("host mengakhiri: kembali ke ruang tunggu dan room terbuka lagi", async () => {
    const { url, host, room } = await started();
    await ok(host, "room:action", { action: "end" });
    const view = await ok<GameRoom>(host, "room:sync");
    expect(view.state).toMatchObject({ phase: "waiting", round: 0 });
    expect((await listed(url, room.id)).locked).toBe(false);
  });

  it("pemain keluar sampai tersisa satu: permainan berakhir dan room terbuka lagi", async () => {
    const { url, host, guest, room } = await started();
    await ok(guest, "room:leave");
    const view = await ok<GameRoom>(host, "room:sync");
    expect(view.state.phase).toBe("waiting");
    expect((await listed(url, room.id)).locked).toBe(false);
  });
});

describe("abc-words: huruf dari jumlah angka", () => {
  it.each([
    [1, "A"],
    [14, "N"],
    [26, "Z"],
    [27, "A"],
    [80, "B"],
  ])("total %i menjadi %s", (total, letter) => {
    expect(drawLetter(total, [])).toEqual({ letter, skippedFrom: null });
  });

  it("lompat ke huruf berikutnya yang belum keluar", () => {
    expect(drawLetter(14, ["N", "O"])).toEqual({ letter: "P", skippedFrom: "N" });
  });

  it("lompat melewati Z kembali ke A", () => {
    expect(drawLetter(26, ["Z"])).toEqual({ letter: "A", skippedFrom: "Z" });
  });
});

describe("abc-words: pilih angka dan huruf", () => {
  const fast = createAbcWordsModule({ pickMs: 120, revealMs: 120, abandonMs: 100, answerMs: 120, resultMs: 120 });

  async function game(players = 2, settings: Partial<AbcWordsSettings> = {}) {
    const { url } = await startServer({}, [fast]);
    const host = await connect(url, { name: "Host" });
    const room = await ok<GameRoom>(host, "room:create", { type: "abc-words", isPublic: true, settings });
    const guests = [];
    for (let i = 0; i < players - 1; i++) {
      const guest = await connect(url, { name: `Tamu${i}` });
      await ok(guest, "room:join", { roomId: room.id });
      guests.push(guest);
    }
    await ok(host, "room:action", { action: "start" });
    return { url, host, guests, guest: guests[0]!, room };
  }
  const pick = (socket: Parameters<typeof ok>[0], value: number) =>
    ok(socket, "room:action", { action: "pick", payload: { value } });
  const state = async (socket: Parameters<typeof ok>[0]) => (await ok<GameRoom>(socket, "room:sync")).state;
  /** Dari huruf muncul, lewati fase menjawab dan peninjauan. */
  const skipRestOfRound = async (socket: Parameters<typeof ok>[0]) => {
    for (let i = 0; i < 3; i++) {
      await sleep(150);
      await ok(socket, "room:action", { action: "tick" });
    }
  };

  it("angka pemain lain dirahasiakan selama memilih", async () => {
    const { host, guest } = await game();
    await pick(host, 7);

    const seenByGuest = await state(guest);
    expect(seenByGuest.myPick).toBeNull();
    expect(seenByGuest.pickedBy).toEqual([host.session.userId]);
    expect(seenByGuest).not.toHaveProperty("picks");
    expect(JSON.stringify(seenByGuest)).not.toContain('"value"');

    expect((await state(host)).myPick).toBe(7);
  });

  it("begitu semua memilih, huruf langsung ditentukan dari jumlahnya", async () => {
    const { host, guest } = await game();
    await pick(host, 5);
    await pick(guest, 9);

    const { phase, reveal, usedLetters } = await state(host);
    expect(phase).toBe("reveal");
    expect(reveal).toMatchObject({ total: 14, letter: "N", skippedFrom: null });
    expect(reveal!.picks.map((p) => p.value).sort((a, b) => a - b)).toEqual([5, 9]);
    expect(usedLetters).toEqual(["N"]);
  });

  it("pilihan bisa diganti sebelum semua selesai", async () => {
    const { host, guest } = await game();
    await pick(host, 2);
    await pick(host, 10);
    await pick(guest, 1);
    expect((await state(host)).reveal?.total).toBe(11);
  });

  it.each([0, 11, 2.5])("menolak angka %d", async (value) => {
    const { host } = await game();
    expect(await call(host, "room:action", { action: "pick", payload: { value } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("tidak bisa memilih di luar fase memilih", async () => {
    const { host, guest } = await game();
    await pick(host, 1);
    await pick(guest, 1);
    expect(await call(host, "room:action", { action: "pick", payload: { value: 3 } })).toMatchObject({
      ok: false,
      error: { code: "WRONG_PHASE" },
    });
  });

  it("tick sebelum waktunya ditolak, jadi client tidak bisa mempercepat fase", async () => {
    const { guest } = await game();
    expect(await call(guest, "room:action", { action: "tick" })).toMatchObject({
      ok: false,
      error: { code: "NOT_DUE" },
    });
  });

  it("waktu habis: yang belum memilih diberi angka acak 1–10", async () => {
    const { host, guest } = await game();
    await pick(host, 4);
    await sleep(150);
    await ok(guest, "room:action", { action: "tick" });

    const { reveal } = await state(host);
    const byHost = reveal!.picks.find((p) => p.userId === host.session.userId)!;
    const byGuest = reveal!.picks.find((p) => p.userId === guest.session.userId)!;
    expect(byHost).toMatchObject({ value: 4, auto: false });
    expect(byGuest.auto).toBe(true);
    expect(byGuest.value).toBeGreaterThanOrEqual(1);
    expect(byGuest.value).toBeLessThanOrEqual(10);
  });

  it("huruf yang sama tidak keluar dua kali dalam satu game", async () => {
    const { host, guest } = await game();
    await pick(host, 1);
    await pick(guest, 1); // B
    await skipRestOfRound(host);
    await pick(host, 1);
    await pick(guest, 1); // B lagi -> C

    const { reveal, usedLetters, round } = await state(host);
    expect(round).toBe(2);
    expect(reveal).toMatchObject({ letter: "C", skippedFrom: "B" });
    expect(usedLetters).toEqual(["B", "C"]);
  });

  it("setelah ronde terakhir kembali ke ruang tunggu dan room terbuka", async () => {
    const { host, guest, url, room } = await game(2, { maxRounds: 1 });
    await pick(host, 1);
    await pick(guest, 1);
    await skipRestOfRound(host);
    expect((await state(host)).phase).toBe("finished");
    await ok(host, "room:action", { action: "end" });

    const after = await ok<GameRoom>(host, "room:sync");
    expect(after.state).toMatchObject({ phase: "waiting", round: 0, usedLetters: [], reveal: null });
    expect(after.locked).toBe(false);
    const body = (await (await fetch(`${url}/api/rooms`)).json()) as { data: RoomSummary[] };
    expect(body.data.find((r) => r.id === room.id)?.locked).toBe(false);
  });

  it("pemain yang keluar tidak ditunggu", async () => {
    const { host, guests } = await game(3);
    await pick(host, 2);
    await pick(guests[0]!, 3);
    await ok(guests[1]!, "room:leave");

    const { phase, reveal } = await state(host);
    expect(phase).toBe("reveal");
    expect(reveal?.total).toBe(5);
  });

  it("pemain yang putus koneksi tidak ditunggu dan diberi angka acak", async () => {
    const { host, guests } = await game(3);
    await pick(host, 2);
    await pick(guests[0]!, 3);
    guests[1]!.disconnect();
    await sleep(60);

    const { phase, reveal } = await state(host);
    expect(phase).toBe("reveal");
    expect(reveal!.picks.filter((p: Reveal["picks"][number]) => p.auto)).toHaveLength(1);
  });

  it("jam server memajukan fase sendiri tanpa aksi dari pemain", async () => {
    const config = loadConfig({ NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "silent" });
    const server = createAbcWordsServer(config, undefined, [fast]);
    const port = await server.start();
    const url = `http://127.0.0.1:${port}`;
    try {
      const host = await connect(url, { name: "Host" });
      const guest = await connect(url, { name: "Tamu" });
      const room = await ok<GameRoom>(host, "room:create", { type: "abc-words" });
      await ok(guest, "room:join", { roomId: room.id });

      const revealed = waitFor<GameRoom>(guest, "room:state", (r) => r.state.phase === "reveal", 2000);
      const nextRound = waitFor<GameRoom>(guest, "room:state", (r) => r.state.round === 2, 2000);
      await ok(host, "room:action", { action: "start" });

      expect((await revealed).state.reveal?.picks.every((p) => p.auto)).toBe(true);
      expect((await nextRound).state.phase).toBe("picking");
    } finally {
      await cleanup();
      await server.stop();
    }
  });
});

describe("abc-words: pemain putus koneksi di tengah permainan", () => {
  // Masa tunggu reconnect dibuat panjang: pemain yang putus tetap tercatat sebagai member.
  const env = { RECONNECT_GRACE_MS: "5000" };

  async function playing(abandonMs: number, players = 2) {
    const module = createAbcWordsModule({ pickMs: 5000, revealMs: 5000, abandonMs });
    const { url } = await startServer(env, [module]);
    const host = await connect(url, { name: "Host" });
    const room = await ok<GameRoom>(host, "room:create", { type: "abc-words", isPublic: true });
    const guests = [];
    for (let i = 0; i < players - 1; i++) {
      const guest = await connect(url, { name: `Tamu${i}` });
      await ok(guest, "room:join", { roomId: room.id });
      guests.push(guest);
    }
    await ok(host, "room:action", { action: "start" });
    return { url, host, guests, guest: guests[0]!, room };
  }

  it("tersisa satu pemain online: permainan berakhir dan pesannya sampai ke room", async () => {
    const { host, guest } = await playing(60);
    guest.disconnect();
    await sleep(120);
    await ok(host, "room:action", { action: "tick" });

    const view = await ok<GameRoom>(host, "room:sync");
    expect(view.state).toMatchObject({
      phase: "waiting",
      endedReason: "Permainan berakhir karena pemain lain terputus",
    });
    expect(view.state.messages.at(-1)?.text).toBe("Permainan berakhir karena pemain lain terputus");
    expect(view.locked).toBe(false);
    expect(view.members).toHaveLength(2); // masih dalam masa tunggu reconnect
  });

  it("host yang putus juga mengakhiri permainan", async () => {
    const { host, guest } = await playing(60);
    host.disconnect();
    await sleep(120);
    await ok(guest, "room:action", { action: "tick" });
    expect((await ok<GameRoom>(guest, "room:sync")).state.phase).toBe("waiting");
  });

  it("refresh atau putus sebentar tidak mengakhiri permainan", async () => {
    const { url, host, guest } = await playing(200);
    const token = guest.session.sessionToken!;
    guest.disconnect();
    await sleep(40);
    await connect(url, { name: "Tamu0", sessionToken: token });
    await sleep(260);

    expect(await call(host, "room:action", { action: "tick" })).toMatchObject({
      ok: false,
      error: { code: "NOT_DUE" },
    });
    expect((await ok<GameRoom>(host, "room:sync")).state.phase).toBe("picking");
  });

  it("masih ada 2 pemain online: permainan tetap berjalan", async () => {
    const { host, guests } = await playing(60, 3);
    guests[1]!.disconnect();
    await sleep(120);
    expect(await call(host, "room:action", { action: "tick" })).toMatchObject({
      ok: false,
      error: { code: "NOT_DUE" },
    });
  });

  it("alasan berakhir hilang saat permainan baru dimulai", async () => {
    const { host, guests } = await playing(60, 3);
    await ok(host, "room:action", { action: "end" });
    expect((await ok<GameRoom>(host, "room:sync")).state.endedReason).toBe("Host mengakhiri permainan");
    await ok(host, "room:action", { action: "start" });
    expect((await ok<GameRoom>(guests[0]!, "room:sync")).state.endedReason).toBeNull();
  });

  it("jam server mengakhiri permainan tanpa aksi dari pemain", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_LEVEL: "silent",
      ...env,
    });
    const module = createAbcWordsModule({ pickMs: 5000, revealMs: 5000, abandonMs: 100 });
    const server = createAbcWordsServer(config, undefined, [module]);
    const url = `http://127.0.0.1:${await server.start()}`;
    try {
      const host = await connect(url, { name: "Host" });
      const guest = await connect(url, { name: "Tamu" });
      const room = await ok<GameRoom>(host, "room:create", { type: "abc-words" });
      await ok(guest, "room:join", { roomId: room.id });
      await ok(host, "room:action", { action: "start" });

      const ended = waitFor<GameRoom>(host, "room:state", (r) => r.state.phase === "waiting", 2000);
      guest.disconnect();
      expect((await ended).state.endedReason).toContain("terputus");
    } finally {
      await cleanup();
      await server.stop();
    }
  });
});

describe("abc-words: host offline", () => {
  const env = { RECONNECT_GRACE_MS: "5000" };

  async function room(hostAwayMs: number) {
    const config = loadConfig({ NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "silent", ...env });
    const module = createAbcWordsModule({ pickMs: 5000, revealMs: 5000, abandonMs: 5000 });
    const server = createAbcWordsServer(config, undefined, [module], { hostAwayMs });
    const url = `http://127.0.0.1:${await server.start()}`;
    const host = await connect(url, { name: "Host" });
    const first = await connect(url, { name: "Pertama" });
    const second = await connect(url, { name: "Kedua" });
    const created = await ok<GameRoom>(host, "room:create", { type: "abc-words", isPublic: true });
    await ok(first, "room:join", { roomId: created.id });
    await ok(second, "room:join", { roomId: created.id });
    return { url, server, host, first, second };
  }

  it("host pindah ke pemain online terlama, kursi host lama tetap ada, game tetap jalan", async () => {
    const { url, server, host, first, second } = await room(100);
    try {
      await ok(host, "room:action", { action: "start" });
      const token = host.session.sessionToken!;
      const moved = waitFor<GameRoom>(second, "room:state", (r) => r.hostId === first.session.userId, 2000);
      host.disconnect();

      const view = await moved;
      expect(view.state.phase).toBe("picking");
      expect(view.members).toHaveLength(3);
      expect(view.state.messages.at(-1)?.text).toBe("Pertama sekarang menjadi host");

      // Host baru bisa memakai aksi host; host lama kembali sebagai pemain biasa.
      const back = await connect(url, { name: "Host", sessionToken: token });
      const after = await ok<GameRoom>(back, "room:sync");
      expect(after.hostId).toBe(first.session.userId);
      expect(after.members.find((m) => m.userId === back.session.userId)?.role).toBe("member");
      expect(await call(back, "room:action", { action: "end" })).toMatchObject({
        ok: false,
        error: { code: "NOT_HOST" },
      });
      await ok(first, "room:action", { action: "end" });
    } finally {
      await cleanup();
      await server.stop();
    }
  });

  it("berlaku juga di ruang tunggu", async () => {
    const { server, host, first } = await room(100);
    try {
      const moved = waitFor<GameRoom>(first, "room:state", (r) => r.hostId === first.session.userId, 2000);
      host.disconnect();
      await moved;
      await ok(first, "room:update", { settings: { maxRounds: 3 } });
    } finally {
      await cleanup();
      await server.stop();
    }
  });

  it("host yang refresh atau putus sebentar tetap host", async () => {
    const { url, server, host, first } = await room(500);
    try {
      const token = host.session.sessionToken!;
      host.disconnect();
      await sleep(50);
      await connect(url, { name: "Host", sessionToken: token });
      await sleep(800);
      expect((await ok<GameRoom>(first, "room:sync")).hostId).toBe(host.session.userId);
    } finally {
      await cleanup();
      await server.stop();
    }
  });
});

describe("abc-words: menjawab", () => {
  type Socket = Parameters<typeof ok>[0];
  const answer = (socket: Socket, text: string) =>
    call<{ status: string }>(socket, "room:action", { action: "answer", payload: { text } });
  const state = async (socket: Socket) => (await ok<GameRoom>(socket, "room:sync")).state;

  /** Semua pemain memilih angka `pick`, lalu masuk ke fase menjawab. */
  async function answering(players: number, picks: number[], timing: Parameters<typeof createAbcWordsModule>[0] = {}) {
    const module = createAbcWordsModule({
      pickMs: 5000,
      revealMs: 1,
      answerMs: 5000,
      lastPlayerMs: 5000,
      minAnswerMs: 0,
      votingMs: 5000,
      resultMs: 5000,
      ...timing,
    });
    const { url } = await startServer({ RECONNECT_GRACE_MS: "5000" }, [module]);
    const sockets = [await connect(url, { name: "Host" })];
    const room = await ok<GameRoom>(sockets[0]!, "room:create", { type: "abc-words", isPublic: true });
    for (let i = 1; i < players; i++) {
      const guest = await connect(url, { name: `Tamu${i}` });
      await ok(guest, "room:join", { roomId: room.id });
      sockets.push(guest);
    }
    await ok(sockets[0]!, "room:action", { action: "start" });
    for (let i = 0; i < players; i++) {
      await ok(sockets[i]!, "room:action", { action: "pick", payload: { value: picks[i] } });
    }
    await sleep(10);
    await ok(sockets[0]!, "room:action", { action: "tick" });
    return { url, sockets, a: sockets[0]!, b: sockets[1]!, c: sockets[2]! };
  }

  it("jawaban masuk ke board semua pemain, tanpa data internal", async () => {
    const { a, b, c } = await answering(3, [1, 1, 1]); // C
    expect(await answer(a, "  Cicak ")).toMatchObject({ ok: true, data: { status: "accepted" } });

    const seen = await state(c);
    expect(seen.phase).toBe("answering");
    expect(seen.answers).toHaveLength(1);
    expect(seen.answers[0]).toMatchObject({ name: "Host", text: "Cicak" });
    expect(seen.answers[0]).not.toHaveProperty("key");
    expect(await state(b)).not.toHaveProperty("graceUsedBy");
  });

  it("3 jawaban ditolak dalam waktu singkat: jeda sebelum boleh menjawab lagi", async () => {
    const { a, b, c } = await answering(3, [1, 1, 1], { nearTieMs: 0, retryWindowMs: 5000, retryCooldownMs: 150 }); // C
    expect(await answer(a, "Cicak")).toMatchObject({ ok: true, data: { status: "accepted" } });

    const first = await answer(b, "Cicak");
    expect(first).toMatchObject({ ok: true, data: { status: "duplicate" } });
    expect((first as { data: object }).data).not.toHaveProperty("retryAfterMs");
    expect(await answer(b, "Domba")).toMatchObject({ ok: false, error: { code: "WRONG_LETTER" } });
    // Penolakan ke-3 langsung memberi tahu jedanya.
    expect(await answer(b, "C")).toMatchObject({
      ok: false,
      error: { code: "INVALID_ANSWER", details: { retryAfterMs: 150 } },
    });

    const blocked = await answer(b, "Cumi");
    expect(blocked).toMatchObject({ ok: false, error: { code: "SLOW_DOWN" } });
    const retryAfterMs = (blocked as { error: { details: { retryAfterMs: number } } }).error.details.retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(150);

    // Pemain lain tidak terpengaruh.
    expect(await answer(c, "Capung")).toMatchObject({ ok: true, data: { status: "accepted" } });

    await sleep(170);
    expect(await answer(b, "Cumi")).toMatchObject({ ok: true, data: { status: "accepted" } });
  });

  it("keduluan tidak dihitung sebagai percobaan ditolak", async () => {
    const { a, b } = await answering(3, [1, 1, 1], { nearTieMs: 5000, retryWindowMs: 5000, retryCooldownMs: 5000 });
    await answer(a, "Cicak");
    expect(await answer(b, "Cicak")).toMatchObject({ ok: true, data: { status: "near-tie" } });
    expect(await answer(b, "Cicak")).toMatchObject({ ok: true, data: { status: "duplicate" } });
    expect(await answer(b, "Cicak")).toMatchObject({ ok: true, data: { status: "duplicate" } });
    expect(await answer(b, "Cumi")).toMatchObject({ ok: true, data: { status: "accepted" } }); // baru 2 yang dihitung
  });

  it("penolakan yang berjarak tidak memicu jeda", async () => {
    const { a, b } = await answering(3, [1, 1, 1], { nearTieMs: 0, retryWindowMs: 60, retryCooldownMs: 5000 }); // C
    await answer(a, "Cicak");
    // Keduluan (sial, bukan menebak) juga tidak dihitung; di sini dimatikan lewat nearTieMs: 0.
    for (let i = 0; i < 3; i++) {
      expect(await answer(b, "Cicak")).toMatchObject({ ok: true, data: { status: "duplicate" } });
      await sleep(80);
    }
    expect(await answer(b, "Cumi")).toMatchObject({ ok: true, data: { status: "accepted" } });
  });

  it("boleh lebih dari satu kata dan huruf beraksen", async () => {
    const { a, b } = await answering(3, [9, 9, 1]); // S
    expect(await answer(a, "Seventeen Again")).toMatchObject({ ok: true });
    expect(await answer(b, "Séance")).toMatchObject({ ok: true });
  });

  it.each([
    ["angka", "C4 kucing", "INVALID_ANSWER"],
    ["tanda baca", "Ca-ca", "INVALID_ANSWER"],
    ["tag html", "<c>", "INVALID_ANSWER"],
    ["satu karakter", "C", "INVALID_ANSWER"],
    ["kosong", "   ", "INVALID_ANSWER"],
    ["terlalu panjang", `C${"a".repeat(40)}`, "INVALID_ANSWER"],
    ["huruf awal salah", "Anjing", "WRONG_LETTER"],
  ])("menolak %s", async (_label, text, code) => {
    const { a } = await answering(3, [1, 1, 1]);
    expect(await answer(a, text)).toMatchObject({ ok: false, error: { code } });
  });

  it("satu pemain hanya bisa menjawab sekali", async () => {
    const { a } = await answering(3, [1, 1, 1]);
    await answer(a, "Cicak");
    expect(await answer(a, "Cumi")).toMatchObject({ ok: false, error: { code: "ALREADY_ANSWERED" } });
  });

  it("jawaban yang masuk terlalu cepat ditolak", async () => {
    const { a } = await answering(3, [1, 1, 1], { minAnswerMs: 5000 });
    expect(await answer(a, "Cicak")).toMatchObject({ ok: false, error: { code: "TOO_FAST" } });
  });

  it("jawaban sama ditolak tanpa membedakan huruf besar, aksen, dan spasi; boleh coba lagi", async () => {
    const { a, b, c } = await answering(3, [1, 1, 1], { nearTieMs: 0, retryCooldownMs: 0 });
    await answer(a, "Cicak Hijau");

    for (const text of ["cicak hijau", "  CICAK   HIJAU ", "Cícak Hijau"]) {
      expect(await answer(b, text)).toMatchObject({ ok: true, data: { status: "duplicate" } });
    }
    expect((await state(c)).answers).toHaveLength(1);
    expect(await answer(b, "Cumi")).toMatchObject({ ok: true, data: { status: "accepted" } });
  });

  it("keduluan: waktu ditambah, hanya sekali per ronde", async () => {
    const { a, b, c } = await answering(4, [1, 1, 1, 1], { answerMs: 300, graceMs: 2000, nearTieMs: 1000 }); // D
    await answer(a, "Domba");
    expect(await answer(b, "domba")).toMatchObject({ ok: true, data: { status: "near-tie" } });
    expect((await state(c)).remainingMs).toBeGreaterThan(1500);

    expect(await answer(b, "domba")).toMatchObject({ ok: true, data: { status: "duplicate" } });
  });

  it("keduluan tidak memendekkan waktu yang masih panjang", async () => {
    const { a, b, c } = await answering(4, [1, 1, 1, 1], { answerMs: 5000, graceMs: 100, nearTieMs: 1000 });
    await answer(a, "Domba");
    await answer(b, "domba");
    expect((await state(c)).remainingMs).toBeGreaterThan(4000);
  });

  it("jawaban sama setelah lewat selang keduluan tidak dapat tambahan waktu", async () => {
    const { a, b } = await answering(4, [1, 1, 1, 1], { nearTieMs: 20 });
    await answer(a, "Domba");
    await sleep(40);
    expect(await answer(b, "domba")).toMatchObject({ ok: true, data: { status: "duplicate" } });
  });

  it("tinggal satu pemain: dapat waktu khusus", async () => {
    const { a, b, c } = await answering(3, [1, 1, 1], { lastPlayerMs: 800 });
    await answer(a, "Cicak");
    expect((await state(c)).remainingMs).toBeGreaterThan(1000);
    await answer(b, "Cumi");
    expect((await state(c)).remainingMs).toBeLessThanOrEqual(800);
  });

  it("semua sudah menjawab: fase langsung selesai", async () => {
    const { a, b } = await answering(2, [1, 2]); // C
    await answer(a, "Cicak");
    await answer(b, "Cumi");
    expect((await state(a)).phase).toBe("voting");
  });

  it("waktu habis: fase selesai dan jawaban tidak diterima lagi", async () => {
    const { a, b } = await answering(3, [1, 1, 1], { answerMs: 30 });
    await sleep(50);
    expect(await answer(b, "Cicak")).toMatchObject({ ok: false, error: { code: "WRONG_PHASE" } });
    await ok(a, "room:action", { action: "tick" });
    expect((await state(a)).phase).toBe("result");
  });

  it("pemain yang putus tidak ditunggu", async () => {
    const { a, b, c } = await answering(3, [1, 1, 1]);
    await answer(a, "Cicak");
    await answer(b, "Cumi");
    expect((await state(a)).phase).toBe("answering");
    c.disconnect();
    await sleep(60);
    expect((await state(a)).phase).toBe("voting");
  });

  it("setelah voting dan hasil lanjut ke ronde berikutnya dengan jawaban kosong", async () => {
    const { a, b } = await answering(2, [1, 2], { votingMs: 20, resultMs: 20 });
    await answer(a, "Cicak");
    await answer(b, "Cumi");
    for (let i = 0; i < 2; i++) {
      await sleep(40);
      await ok(a, "room:action", { action: "tick" });
    }

    const next = await state(b);
    expect(next).toMatchObject({ phase: "picking", round: 2, answers: [], reveal: null, usedLetters: ["C"] });
  });
});

describe("abc-words: voting dan skor", () => {
  type Socket = Parameters<typeof ok>[0];
  const answer = (socket: Socket, text: string) => ok(socket, "room:action", { action: "answer", payload: { text } });
  const reject = (socket: Socket, target: Socket, rejected = true, reason: string = "off-category") =>
    call(socket, "room:action", {
      action: "reject",
      payload: { answerUserId: idOf(target), rejected, ...(rejected && { reason }) },
    });
  const idOf = (socket: Socket) => (socket as unknown as { session: { userId: string } }).session.userId;
  const state = async (socket: Socket) => (await ok<GameRoom>(socket, "room:sync")).state;
  const tick = async (socket: Socket) => {
    await sleep(15);
    await ok(socket, "room:action", { action: "tick" });
  };
  const verdict = async (socket: Socket, target: Socket) =>
    (await state(socket)).answers.find((a) => a.userId === idOf(target))?.accepted;

  /** Semua memilih angka 1 lalu menjawab sesuai `words` (kosong = tidak menjawab); berhenti di voting. */
  async function voting(words: string[], settings: Partial<AbcWordsSettings> = {}) {
    const module = createAbcWordsModule({
      pickMs: 5000,
      revealMs: 1,
      answerMs: 30,
      lastPlayerMs: 30,
      minAnswerMs: 0,
      votingMs: 5,
      resultMs: 5,
      finishedMs: 5,
      abandonMs: 5000,
    });
    const { url } = await startServer({ RECONNECT_GRACE_MS: "5000" }, [module]);
    const sockets: Socket[] = [await connect(url, { name: "Pemain0" })];
    const room = await ok<GameRoom>(sockets[0]!, "room:create", { type: "abc-words", isPublic: true, settings });
    for (let i = 1; i < words.length; i++) {
      const socket = await connect(url, { name: `Pemain${i}` });
      await ok(socket, "room:join", { roomId: room.id });
      sockets.push(socket);
    }
    await ok(sockets[0]!, "room:action", { action: "start" });
    await playRound(sockets, words);
    return { sockets, url };
  }

  async function playRound(sockets: Socket[], words: string[]) {
    for (const socket of sockets) await ok(socket, "room:action", { action: "pick", payload: { value: 1 } });
    await tick(sockets[0]!); // huruf -> menjawab
    const letter = (await state(sockets[0]!)).reveal!.letter.toLowerCase();
    // Jawaban disesuaikan dengan huruf ronde ini, supaya ronde mana pun bisa dimainkan.
    for (let i = 0; i < sockets.length; i++) {
      if (words[i]) await answer(sockets[i]!, `${letter}${words[i]}`);
    }
    const now = await state(sockets[0]!);
    if (now.phase === "answering") await sleep(40);
    if ((await state(sockets[0]!)).phase === "answering") await tick(sockets[0]!);
  }

  it("kata gugur kalau lebih dari separuh pemain lain menolak", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await reject(p1, p0);
    await reject(p2, p0); // 2 dari 2 pemain lain
    await reject(p0, p1); // 1 dari 2: seri, tetap lolos
    await tick(p0);

    const now = await state(p0);
    expect(now.phase).toBe("result");
    expect(await verdict(p0, p0)).toBe(false);
    expect(await verdict(p0, p1)).toBe(true);
    expect(await verdict(p0, p2)).toBe(true);
    // Skor 0 tidak turun lagi saat gugur.
    expect(now.scores).toEqual({ [idOf(p0)]: 0, [idOf(p1)]: 1, [idOf(p2)]: 1 });
    expect(now.answers.map((a) => a.points)).toEqual([0, 1, 1]);
  });

  it("game 2 pemain: satu penolakan menggugurkan kata", async () => {
    const { sockets } = await voting(["aa", "bb"]);
    const [p0, p1] = sockets as [Socket, Socket];
    await reject(p1, p0);
    await tick(p0);
    expect(await verdict(p0, p0)).toBe(false);
    expect(await verdict(p0, p1)).toBe(true);
  });

  it("4 pemain: butuh 2 dari 3 pemain lain", async () => {
    const { sockets } = await voting(["aa", "bb", "cc", "dd"]);
    const [p0, p1, p2, p3] = sockets as [Socket, Socket, Socket, Socket];
    await reject(p1, p0);
    await reject(p2, p3);
    await reject(p1, p3);
    await tick(p0);
    expect(await verdict(p0, p0)).toBe(true);
    expect(await verdict(p0, p3)).toBe(false);
  });

  it("suara terbuka: nama penolak terlihat semua pemain, tanpa data internal", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await reject(p1, p0, true, "misspelled");
    const seen = (await state(p2)).answers.find((a) => a.userId === idOf(p0))!;
    expect(seen.rejectedBy).toEqual([{ userId: idOf(p1), name: "Pemain1", reason: "misspelled" }]);
    expect(await state(p2)).not.toHaveProperty("rejectionsUsed");
  });

  it("jawaban sendiri tidak bisa ditolak", async () => {
    const { sockets } = await voting(["aa", "bb"]);
    expect(await reject(sockets[0]!, sockets[0]!)).toMatchObject({ ok: false, error: { code: "OWN_ANSWER" } });
  });

  it("pemain yang tidak menjawab tetap boleh menolak", async () => {
    const { sockets } = await voting(["aa", "bb", ""]);
    const [p0, p2] = [sockets[0]!, sockets[2]!];
    expect(await reject(p2, p0)).toMatchObject({ ok: true });
    expect(await reject(p0, p2)).toMatchObject({ ok: false, error: { code: "ANSWER_NOT_FOUND" } });
  });

  it("tidak menjawab -1, tidak sampai di bawah 0", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"], { maxRounds: 3 });
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await tick(p0); // ronde 1: semua +1
    await tick(p0);

    await playRound(sockets, ["aa", "bb", ""]);
    await tick(p0); // hasil ronde 2
    let now = await state(p0);
    expect(now.scores).toEqual({ [idOf(p0)]: 2, [idOf(p1)]: 2, [idOf(p2)]: 0 });
    expect(now.penalties).toEqual([
      { userId: idOf(p2), name: "Pemain2", reason: "no-answer", answerText: null, strike: null, warning: false, points: -1 },
    ]);
    await tick(p0);

    await playRound(sockets, ["aa", "bb", ""]);
    await tick(p0); // hasil ronde 3: sudah 0
    now = await state(p0);
    expect(now.scores[idOf(p2)]).toBe(0);
    expect(now.penalties[0]!.points).toBe(0);
  });

  it("tidak ada yang menjawab: semua -1", async () => {
    const { sockets } = await voting(["aa", "bb"], { maxRounds: 2 });
    const [p0, p1] = sockets as [Socket, Socket];
    await tick(p0);
    await tick(p0);
    await playRound(sockets, ["", ""]);
    const now = await state(p0);
    expect(now.phase).toBe("result");
    expect(now.scores).toEqual({ [idOf(p0)]: 0, [idOf(p1)]: 0 });
    expect(now.penalties.map((p) => p.reason)).toEqual(["no-answer", "no-answer"]);
  });

  it("menolak sendirian: pertama diam, kedua peringatan, ketiga kali -1", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"], { maxRounds: 4 });
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    const loneOf = async () => (await state(p0)).penalties.filter((p) => p.reason === "lone-rejection");

    // Ronde 1-2: p1 menolak p0 sendirian, p0 tetap lolos.
    // Pertama: diam-diam. Kedua: peringatan tanpa potongan.
    for (const strike of [1, 2]) {
      if (strike > 1) await playRound(sockets, ["aa", "bb", "cc"]);
      await reject(p1, p0);
      await tick(p0); // hasil
      expect(await verdict(p0, p0)).toBe(true);
      expect(await loneOf()).toEqual(
        strike === 1
          ? []
          : [
              {
                userId: idOf(p1),
                name: "Pemain1",
                reason: "lone-rejection",
                answerText: expect.any(String),
                strike,
                warning: true,
                points: 0,
              },
            ],
      );
      expect((await state(p2)).loneRejections).toEqual({ [idOf(p1)]: strike });
      await tick(p0);
    }
    expect((await state(p0)).scores[idOf(p1)]).toBe(2);

    // Ronde 3: ketiga kali, -1.
    await playRound(sockets, ["aa", "bb", "cc"]);
    await reject(p1, p0);
    await tick(p0);
    expect(await loneOf()).toMatchObject([{ userId: idOf(p1), strike: 3, warning: false, points: -1 }]);
    expect((await state(p0)).scores[idOf(p1)]).toBe(2); // 2 + 1 - 1
    await tick(p0);

    // Tolakan yang didukung pemain lain tidak dihitung sebagai tolakan sendirian.
    // (Jatah tolak p1 sudah habis: tolakan sendirian tidak dikembalikan.)
    await playRound(sockets, ["aa", "bb", "cc"]);
    await reject(p0, p1);
    await reject(p2, p1);
    await tick(p0);
    expect(await loneOf()).toEqual([]);
    expect((await state(p0)).loneRejections[idOf(p1)]).toBe(3);
  });

  it("permainan baru: hitungan tolakan sendirian kembali 0", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"], { maxRounds: 1 });
    const [p0, p1] = sockets as [Socket, Socket];
    await reject(p1, p0);
    await tick(p0); // hasil
    await tick(p0); // skor akhir
    await tick(p0); // ruang tunggu
    expect((await state(p0)).loneRejections).toEqual({});
  });

  it("menolak sendirian tapi kalah suara bersama pemain lain: tidak ada hukuman", async () => {
    const { sockets } = await voting(["aa", "bb", "cc", "dd", "ee"]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await reject(p1, p0);
    await reject(p2, p0); // 2 dari 4: seri, lolos, tapi p1 tidak sendirian
    await tick(p0);
    expect(await verdict(p0, p0)).toBe(true);
    expect((await state(p0)).penalties).toEqual([]);
  });

  it("game 2 pemain: tolakan sendirian tidak dihukum (jawaban pasti gugur)", async () => {
    const { sockets } = await voting(["aa", "bb"]);
    const [p0, p1] = sockets as [Socket, Socket];
    await reject(p1, p0);
    await tick(p0);
    expect(await verdict(p0, p0)).toBe(false);
    expect((await state(p0)).penalties).toEqual([]);
  });

  it("jatah tolak 3 per permainan; membatalkan mengembalikan jatah", async () => {
    const { sockets } = await voting(["aa", "bb", "cc", "dd", "ee"]);
    const [p0, p1, p2, p3, p4] = sockets as [Socket, Socket, Socket, Socket, Socket];
    await reject(p0, p1);
    await reject(p0, p1); // menolak dua kali tidak memakai jatah lagi
    await reject(p0, p2);
    await reject(p0, p3);
    expect((await state(p0)).rejectionsLeft).toBe(0);
    expect((await state(p1)).rejectionsLeft).toBe(3);
    expect(await reject(p0, p4)).toMatchObject({ ok: false, error: { code: "NO_REJECTIONS_LEFT" } });

    await reject(p0, p3, false);
    expect((await state(p0)).rejectionsLeft).toBe(1);
    expect(await reject(p0, p4)).toMatchObject({ ok: true });
  });

  it("menolak wajib dengan alasan yang dikenal", async () => {
    const { sockets } = await voting(["aa", "bb"]);
    const [p0, p1] = sockets as [Socket, Socket];
    const bare = await call(p1, "room:action", { action: "reject", payload: { answerUserId: idOf(p0), rejected: true } });
    expect(bare).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(await reject(p1, p0, true, "jelek")).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect((await state(p1)).rejectionsLeft).toBe(1);
  });

  it("mengganti alasan tidak memakai jatah lagi", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await reject(p1, p0, true, "off-category");
    await reject(p1, p0, true, "not-a-word");
    const seen = (await state(p2)).answers.find((a) => a.userId === idOf(p0))!;
    expect(seen.rejectedBy).toEqual([{ userId: idOf(p1), name: "Pemain1", reason: "not-a-word" }]);
    expect((await state(p1)).rejectionsLeft).toBe(2);
  });

  it("tolakan yang benar dikembalikan; tolakan yang kalah tetap terpakai", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"], { maxRounds: 2 });
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await reject(p1, p0);
    await reject(p2, p0); // p0 gugur: jatah p1 dan p2 kembali
    await reject(p0, p1); // p1 tetap lolos: jatah p0 hangus
    expect((await state(p1)).rejectionsLeft).toBe(2);
    await tick(p0); // hasil
    expect((await state(p0)).rejectionsLeft).toBe(2);
    expect((await state(p1)).rejectionsLeft).toBe(3);
    expect((await state(p2)).rejectionsLeft).toBe(3);

    await tick(p0); // ronde 2: jatah terbawa
    expect((await state(p0)).rejectionsLeft).toBe(2);
  });

  it("jawaban gugur mengurangi 2 poin, tidak sampai di bawah 0", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"], { maxRounds: 4 });
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await tick(p0); // ronde 1: semua lolos
    await tick(p0);
    await playRound(sockets, ["aa", "bb", "cc"]);
    await tick(p0); // ronde 2: semua lolos
    await tick(p0);
    expect((await state(p0)).scores).toEqual({ [idOf(p0)]: 2, [idOf(p1)]: 2, [idOf(p2)]: 2 });

    // Ronde 3: 2 -> 0 (poin -2). Ronde 4: sudah 0, tetap 0 (poin 0).
    for (const points of [-2, 0]) {
      await playRound(sockets, ["aa", "bb", "cc"]);
      await reject(p1, p0);
      await reject(p2, p0);
      await tick(p0); // hasil
      const now = await state(p0);
      expect(now.scores[idOf(p0)]).toBe(0);
      expect(now.answers.find((a) => a.userId === idOf(p0))!.points).toBe(points);
      await tick(p0);
    }
  });

  it("game 2 pemain: jatah tolak 1, dan tolakan sepihak tidak dikembalikan", async () => {
    const { sockets } = await voting(["aa", "bb"], { maxRounds: 2 });
    const [p0, p1] = sockets as [Socket, Socket];
    expect((await state(p1)).rejectionsLeft).toBe(1);
    await reject(p1, p0);
    await tick(p0); // hasil: gugur, tapi jatah tidak kembali
    expect(await verdict(p0, p0)).toBe(false);
    expect((await state(p1)).rejectionsLeft).toBe(0);

    await tick(p0);
    await playRound(sockets, ["aa", "bb"]);
    expect(await reject(p1, p0)).toMatchObject({ ok: false, error: { code: "NO_REJECTIONS_LEFT" } });
  });

  it("game 3 pemain atau lebih: jatah tolak 3", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"]);
    expect((await state(sockets[0]!)).rejectionsLeft).toBe(3);
  });

  it("voting selesai lebih awal saat semua penilai selesai; bisa dibatalkan", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    const done = (s: Socket, value = true) => call(s, "room:action", { action: "doneVoting", payload: { done: value } });
    await reject(p1, p0);
    await reject(p2, p0);
    expect(await done(p0)).toMatchObject({ ok: true });
    expect(await done(p1)).toMatchObject({ ok: true });
    expect(await done(p1, false)).toMatchObject({ ok: true });
    expect(await done(p2)).toMatchObject({ ok: true });
    const mid = await state(p0);
    expect(mid.phase).toBe("voting");
    expect(mid.votingDone.sort()).toEqual([idOf(p0), idOf(p2)].sort());

    await done(p1); // tanpa tick
    const now = await state(p0);
    expect(now.phase).toBe("result");
    expect(await verdict(p0, p0)).toBe(false);
    expect(await done(p0)).toMatchObject({ ok: false, error: { code: "WRONG_PHASE" } });
  });

  it("pemain yang tidak punya jawaban untuk dinilai tidak ditunggu", async () => {
    const { sockets } = await voting(["aa", ""]);
    const [p0, p1] = sockets as [Socket, Socket];
    const done = (s: Socket) => call(s, "room:action", { action: "doneVoting", payload: { done: true } });
    expect(await done(p0)).toMatchObject({ ok: false, error: { code: "NOTHING_TO_JUDGE" } });
    await done(p1);
    expect((await state(p0)).phase).toBe("result");
  });

  it("penilai yang putus tidak ditunggu", async () => {
    const { sockets } = await voting(["aa", "bb", "cc"]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    const done = (s: Socket) => call(s, "room:action", { action: "doneVoting", payload: { done: true } });
    await done(p0);
    await done(p1);
    (p2 as unknown as { disconnect(): void }).disconnect();
    await sleep(30);
    expect((await state(p0)).phase).toBe("result");
  });

  it("pemilih yang putus tidak dihitung", async () => {
    const { sockets } = await voting(["aa", "bb", "cc", "dd"]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    await reject(p1, p0);
    await reject(p2, p0); // 2 dari 3 ...
    (p2 as unknown as { disconnect(): void }).disconnect(); // ... tinggal 1 dari 2: seri
    await sleep(30);
    await tick(p0);
    expect(await verdict(p0, p0)).toBe(true);
  });

  it("tidak ada jawaban: voting dilewati", async () => {
    const { sockets } = await voting(["", ""]);
    expect((await state(sockets[0]!)).phase).toBe("result");
  });

  it("tidak bisa menolak di luar fase voting", async () => {
    const { sockets } = await voting(["aa", "bb"]);
    await tick(sockets[0]!);
    expect(await reject(sockets[1]!, sockets[0]!)).toMatchObject({ ok: false, error: { code: "WRONG_PHASE" } });
  });

  it("skor akhir setelah ronde terakhir, lalu kembali ke ruang tunggu dengan skor bersih", async () => {
    const { sockets } = await voting(["aa", "bb"], { maxRounds: 1 });
    const p0 = sockets[0]!;
    await tick(p0); // hasil
    await tick(p0); // skor akhir
    const final = await state(p0);
    expect(final.phase).toBe("finished");
    expect(Object.values(final.scores)).toEqual([1, 1]);

    await tick(p0); // otomatis kembali
    expect(await state(p0)).toMatchObject({ phase: "waiting", scores: {}, endedReason: "Permainan selesai" });
    expect((await state(p0)).rejectionsLeft).toBe(3);
  });

  it("host menutup skor akhir; pemain lain tidak bisa", async () => {
    const { sockets } = await voting(["aa", "bb"], { maxRounds: 1 });
    const [p0, p1] = sockets as [Socket, Socket];
    await tick(p0);
    await tick(p0);
    expect(await call(p1, "room:action", { action: "end" })).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    await ok(p0, "room:action", { action: "end" });
    expect((await state(p1)).phase).toBe("waiting");
  });

  it("pemain putus di layar skor akhir tidak memutus layar itu", async () => {
    const { sockets } = await voting(["aa", "bb"], { maxRounds: 1 });
    const [p0, p1] = sockets as [Socket, Socket];
    await tick(p0);
    await tick(p0);
    (p1 as unknown as { disconnect(): void }).disconnect();
    await sleep(30);
    expect((await state(p0)).phase).toBe("finished");
  });
});

describe("abc-words: spam chat", () => {
  it("pesan spam ditolak; pelanggaran ke-2 membisukan hanya pemain itu", async () => {
    const module = createAbcWordsModule({}, { muteMs: 200 });
    const { url } = await startServer({}, [module]);
    const a = await connect(url, { name: "Spammer" });
    const b = await connect(url, { name: "Sopan" });
    const room = await ok<GameRoom>(a, "room:create", { type: "abc-words", isPublic: true });
    await ok(b, "room:join", { roomId: room.id });
    const send = (socket: typeof a, text: string) => call(socket, "room:action", { action: "send", payload: { text } });

    await send(a, "spam");
    await send(a, "spam");
    expect(await send(a, "spam")).toMatchObject({ ok: false, error: { code: "CHAT_SLOW_DOWN" } });
    expect(await send(a, "spam")).toMatchObject({
      ok: false,
      error: { code: "CHAT_MUTED", details: { retryAfterMs: 200 } },
    });
    expect(await send(a, "maaf")).toMatchObject({ ok: false, error: { code: "CHAT_MUTED" } });
    expect(await send(b, "halo")).toMatchObject({ ok: true });

    // Tidak ada pengumuman ke room; pesan spam tidak tersimpan.
    const { state } = await ok<GameRoom>(b, "room:sync");
    expect(state.messages.filter((m) => m.userId !== null).map((m) => m.text)).toEqual(["spam", "spam", "halo"]);
    expect(state.messages.some((m) => /bisu/i.test(m.text))).toBe(false);

    await sleep(220);
    expect(await send(a, "maaf")).toMatchObject({ ok: true });
  });

  it("pesan berkata kasar tidak sampai ke pemain lain", async () => {
    const module = createAbcWordsModule();
    const { url } = await startServer({}, [module]);
    const a = await connect(url, { name: "Kasar" });
    const b = await connect(url, { name: "Sopan" });
    const room = await ok<GameRoom>(a, "room:create", { type: "abc-words", isPublic: true });
    await ok(b, "room:join", { roomId: room.id });

    const refused = await call(a, "room:action", { action: "send", payload: { text: "dasar g0bl0k" } });
    expect(refused).toMatchObject({ ok: false, error: { code: "CHAT_PROFANITY" } });
    const { state } = await ok<GameRoom>(b, "room:sync");
    expect(state.messages.some((m) => /g0bl0k/i.test(m.text))).toBe(false);
  });
});

describe("abc-words: AFK", () => {
  type Socket = Parameters<typeof ok>[0];
  const state = async (socket: Socket) => (await ok<GameRoom>(socket, "room:sync")).state;
  const idOf = (socket: Socket) => (socket as unknown as { session: { userId: string } }).session.userId;
  const act = (socket: Socket, action: string, payload?: unknown) =>
    ok(socket, "room:action", { action, ...(payload !== undefined && { payload }) });
  const tick = async (socket: Socket) => {
    await sleep(15);
    await act(socket, "tick");
  };

  /** Fase yang menunggu pemain diam selesai setelah waktu ini lewat (lalu `tick`). */
  const PHASE_MS = 300;
  const waitPhase = async (host: Socket) => {
    await sleep(PHASE_MS + 30);
    await act(host, "tick");
  };

  /** 3 pemain; waktu fase pendek, jadi fase yang menunggu pemain AFK selesai lewat `tick`. */
  async function game() {
    const module = createAbcWordsModule({
      pickMs: PHASE_MS,
      revealMs: 1,
      answerMs: PHASE_MS,
      lastPlayerMs: PHASE_MS,
      minAnswerMs: 0,
      votingMs: PHASE_MS,
      resultMs: 1,
      finishedMs: 5000,
      abandonMs: 5000,
    });
    const { url } = await startServer({ RECONNECT_GRACE_MS: "5000" }, [module]);
    const sockets: Socket[] = [await connect(url, { name: "Aktif0" })];
    const room = await ok<GameRoom>(sockets[0]!, "room:create", { type: "abc-words", isPublic: true, settings: {} });
    for (const name of ["Aktif1", "Diam"]) {
      const socket = await connect(url, { name });
      await ok(socket, "room:join", { roomId: room.id });
      sockets.push(socket);
    }
    await act(sockets[0]!, "start");
    return sockets as [Socket, Socket, Socket];
  }

  /** Satu ronde: dua pemain aktif memilih dan menjawab; `idle` tidak berbuat apa-apa. */
  async function round(active: Socket[], waitForIdle: boolean) {
    const [host] = active as [Socket];
    for (const s of active) await act(s, "pick", { value: 1 });
    if (waitForIdle) {
      expect((await state(host)).phase).toBe("picking"); // masih menunggu yang diam
      await waitPhase(host);
    }
    await tick(host); // huruf -> menjawab
    const letter = (await state(host)).reveal!.letter.toLowerCase();
    await act(active[0]!, "answer", { text: `${letter}aa` });
    await act(active[1]!, "answer", { text: `${letter}bb` });
    if (waitForIdle) {
      expect((await state(host)).phase).toBe("answering");
      await waitPhase(host);
    }
    for (const s of active) await act(s, "doneVoting", { done: true });
    if (waitForIdle) {
      expect((await state(host)).phase).toBe("voting"); // yang diam juga penilai
      await waitPhase(host);
    }
    expect((await state(host)).phase).toBe("result");
  }

  it("AFK_ROUNDS ronde tanpa memilih dan tanpa menjawab: tidak ditunggu lagi, sampai aktif kembali", async () => {
    const [p0, p1, idle] = await game();
    for (let i = 1; i <= AFK_ROUNDS; i++) {
      await round([p0, p1], true);
      expect((await state(p0)).idleRounds[idOf(idle)]).toBe(i);
      await tick(p0); // ronde berikutnya
    }

    // Ronde berikutnya: AFK, jadi pilih angka dan menjawab tidak menunggunya.
    await act(p0, "pick", { value: 1 });
    await act(p1, "pick", { value: 1 });
    expect((await state(p0)).phase).toBe("reveal");
    await tick(p0);
    const letter = (await state(p0)).reveal!.letter.toLowerCase();
    await act(p0, "answer", { text: `${letter}aa` });
    await act(p1, "answer", { text: `${letter}bb` });
    const voting = await state(p0);
    expect(voting.phase).toBe("voting");
    // Pemain AFK juga tidak ditunggu menilai.
    await act(p0, "doneVoting", { done: true });
    await act(p1, "doneVoting", { done: true });
    expect((await state(p0)).phase).toBe("result");
    expect((await state(p0)).penalties.some((p) => p.userId === idOf(idle) && p.reason === "no-answer")).toBe(true);
    await tick(p0);

    // Ronde setelahnya: memilih angka = aktif lagi, dan ditunggu lagi.
    await act(idle, "pick", { value: 1 });
    expect((await state(p0)).idleRounds[idOf(idle)]).toBe(0);
    await act(p0, "pick", { value: 1 });
    expect((await state(p0)).phase).toBe("picking"); // masih menunggu p1
    await act(p1, "pick", { value: 1 });
    expect((await state(p0)).phase).toBe("reveal");
  });

  it("memilih angka tapi tidak menjawab, atau sebaliknya, tidak dihitung AFK", async () => {
    const [p0, p1, idle] = await game();
    await act(idle, "pick", { value: 1 });
    await act(p0, "pick", { value: 1 });
    await act(p1, "pick", { value: 1 });
    await tick(p0);
    const letter = (await state(p0)).reveal!.letter.toLowerCase();
    await act(p0, "answer", { text: `${letter}aa` });
    await act(p1, "answer", { text: `${letter}bb` });
    await waitPhase(p0); // waktu menjawab habis; yang diam tidak menjawab
    for (const s of [p0, p1, idle]) await call(s, "room:action", { action: "doneVoting", payload: { done: true } });
    expect((await state(p0)).idleRounds[idOf(idle)]).toBe(0);
  });
});
