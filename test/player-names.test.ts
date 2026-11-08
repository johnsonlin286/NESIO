import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";
import { createAbcWordsServer } from "../src/project/server.js";
import type { RoomView } from "../src/shared/contract.js";
import type { RoomServer } from "../src/server.js";
import { call, cleanup, connect, ok, sleep } from "./helpers.js";

const servers: RoomServer[] = [];

afterEach(async () => {
  await cleanup();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function start(): Promise<string> {
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "silent",
    RECONNECT_GRACE_MS: "300",
    SOCKET_RATE_LIMIT_MAX: "1000",
  });
  const server = createAbcWordsServer(config, createLogger(config));
  servers.push(server);
  return `http://127.0.0.1:${await server.start()}`;
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => "connected",
    (error: Error) => error.message,
  );

describe("nama pemain", () => {
  it("menolak koneksi tanpa nama atau dengan nama di luar whitelist", async () => {
    const url = await start();
    const bad = [
      undefined,
      "ab",
      "a".repeat(21),
      "<script>alert(1)</script>",
      "budi santoso",
      "budi'--",
      '"><img src=x onerror=alert(1)>',
      "ｂｕｄｉ",
      "budi😀",
      "../etc/passwd",
    ];
    for (const name of bad) {
      expect(await rejection(connect(url, name === undefined ? {} : { name })), String(name)).toBe("INVALID_NAME");
    }
    expect((await connect(url, { name: "budi_01-x" })).session.name).toBe("budi_01-x");
  });

  it("menolak nama yang sedang dipakai (tidak peka huruf besar/kecil)", async () => {
    const url = await start();
    await connect(url, { name: "Budi" });
    expect(await rejection(connect(url, { name: "budi" }))).toBe("NAME_TAKEN");
    expect(await rejection(connect(url, { name: "BUDI" }))).toBe("NAME_TAKEN");
  });

  it("user yang sama boleh reconnect / buka tab lain dengan namanya sendiri", async () => {
    const url = await start();
    const first = await connect(url, { name: "Budi" });
    const token = first.session.sessionToken!;
    const second = await connect(url, { name: "Budi", sessionToken: token });
    expect(second.session.userId).toBe(first.session.userId);
  });

  it("nama tetap tertahan selama masa tunggu reconnect, lalu bebas", async () => {
    const url = await start();
    const budi = await connect(url, { name: "Budi" });
    await ok<RoomView>(budi, "room:create", { type: "chat" });
    budi.disconnect();
    await sleep(50);
    expect(await rejection(connect(url, { name: "Budi" }))).toBe("NAME_TAKEN");

    await sleep(400); // RECONNECT_GRACE_MS = 300
    expect(await rejection(connect(url, { name: "Budi" }))).toBe("connected");
  });

  it("nama bebas segera setelah keluar room dan disconnect", async () => {
    const url = await start();
    const budi = await connect(url, { name: "Budi" });
    await ok(budi, "room:create", { type: "chat" });
    await ok(budi, "room:leave");
    budi.disconnect();
    await sleep(50);
    expect(await rejection(connect(url, { name: "Budi" }))).toBe("connected");
  });

  it("displayName di room:create / room:join diabaikan", async () => {
    const url = await start();
    const host = await connect(url, { name: "Host" });
    const room = await ok<RoomView>(host, "room:create", { type: "chat", displayName: "<b>x</b>" });
    expect(room.members[0]!.name).toBe("Host");

    const guest = await connect(url, { name: "Guest" });
    const joined = await ok<RoomView>(guest, "room:join", { roomId: room.id, displayName: "Host" });
    expect(joined.members.map((m) => m.name).sort()).toEqual(["Guest", "Host"]);
  });
});

describe("satu user, satu room", () => {
  it("tab lain milik user yang sama tidak bisa membuat / masuk room lain, dan ikut melihat room-nya", async () => {
    const url = await start();
    const citra = await connect(url, { name: "Citra" });
    const otherRoom = await ok<RoomView>(citra, "room:create", { type: "chat", isPublic: true });

    const tabA = await connect(url, { name: "Budi" });
    const tabB = await connect(url, { name: "Budi", sessionToken: tabA.session.sessionToken! });
    const statesOnB: string[] = [];
    tabB.on("room:state", (room: RoomView) => statesOnB.push(room.id));

    const own = await ok<RoomView>(tabA, "room:create", { type: "chat", isPublic: true });
    await sleep(50);

    expect(await call(tabB, "room:create", { type: "chat" })).toMatchObject({
      ok: false,
      error: { code: "ALREADY_IN_ROOM" },
    });
    expect(await call(tabB, "room:join", { roomId: otherRoom.id })).toMatchObject({
      ok: false,
      error: { code: "ALREADY_IN_ROOM" },
    });
    expect(statesOnB).toContain(own.id);

    // Tab yang dibuka belakangan langsung dipulihkan ke room yang sama.
    const tabC = await connect(url, { name: "Budi", sessionToken: tabA.session.sessionToken! });
    expect(tabC.session.roomId).toBe(own.id);
  });
});

describe("rooms:changed (daftar room lobby)", () => {
  it("dikirim ke semua koneksi saat daftar room berubah, tidak saat chat", async () => {
    const url = await start();
    const lobby = await connect(url, { name: "Lobi" });
    let signals = 0;
    lobby.on("rooms:changed", () => signals++);
    const settle = async () => {
      await sleep(120); // > BATCH_MS
      const n = signals;
      signals = 0;
      return n;
    };

    const host = await connect(url, { name: "Host" });
    const room = await ok<RoomView>(host, "room:create", { type: "chat", isPublic: true });
    expect(await settle()).toBe(1); // room dibuat

    const guest = await connect(url, { name: "Tamu" });
    await ok(guest, "room:join", { roomId: room.id });
    expect(await settle()).toBe(1); // jumlah pemain berubah

    await ok(guest, "room:action", { action: "send", payload: { text: "halo" } });
    await ok(host, "room:action", { action: "send", payload: { text: "halo juga" } });
    expect(await settle()).toBe(0); // chat tidak mengubah daftar

    await ok(host, "room:leave");
    expect(await settle()).toBe(1); // host keluar + pindah host -> satu sinyal

    await ok(guest, "room:leave");
    expect(await settle()).toBe(1); // room kosong ditutup
  });
});
