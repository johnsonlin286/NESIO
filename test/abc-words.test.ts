import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import {
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
    const { a, b, c } = await answering(3, [1, 1, 1], { nearTieMs: 0 });
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

  it("pemain yang tidak menjawab tetap boleh menolak, dan tidak dapat poin", async () => {
    const { sockets } = await voting(["aa", "bb", ""]);
    const [p0, p1, p2] = sockets as [Socket, Socket, Socket];
    expect(await reject(p2, p0)).toMatchObject({ ok: true });
    expect(await reject(p0, p2)).toMatchObject({ ok: false, error: { code: "ANSWER_NOT_FOUND" } });
    await tick(p0);
    expect((await state(p0)).scores[idOf(p2)]).toBeUndefined();
    expect((await state(p0)).scores[idOf(p1)]).toBe(1);
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
    expect((await state(p1)).rejectionsLeft).toBe(3);
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

  it("jawaban gugur mengurangi 1 poin, tidak sampai di bawah 0", async () => {
    const { sockets } = await voting(["aa", "bb"], { maxRounds: 3 });
    const [p0, p1] = sockets as [Socket, Socket];
    await tick(p0); // ronde 1: dua-duanya lolos
    await tick(p0);
    expect((await state(p0)).scores).toEqual({ [idOf(p0)]: 1, [idOf(p1)]: 1 });

    // Ronde 2: 1 -> 0 (poin -1). Ronde 3: sudah 0, tetap 0 (poin 0).
    for (const points of [-1, 0]) {
      await playRound(sockets, ["aa", "bb"]);
      await reject(p1, p0);
      await tick(p0); // hasil
      const now = await state(p0);
      expect(now.scores[idOf(p0)]).toBe(0);
      expect(now.answers.find((a) => a.userId === idOf(p0))!.points).toBe(points);
      await tick(p0);
    }
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
