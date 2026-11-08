import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomSummary, RoomView } from "../src/shared/contract.js";
import { call, cleanup, connect, ok, sleep, startServer, waitFor } from "./helpers.js";

afterEach(cleanup);

describe("session (guest auth)", () => {
  it("memberi userId + sessionToken, dan userId tetap sama saat reconnect dengan token", async () => {
    const { url } = await startServer();
    const first = await connect(url, { name: "Budi" });
    expect(first.session.userId).toBeTruthy();
    expect(first.session.sessionToken).toBeTruthy();
    expect(first.session.name).toBe("Budi");
    first.disconnect();

    const second = await connect(url, { sessionToken: first.session.sessionToken! });
    expect(second.session.userId).toBe(first.session.userId);
  });

  it("token palsu menghasilkan user baru, bukan mengambil alih user lain", async () => {
    const { url } = await startServer();
    const victim = await connect(url);
    const forged = `v1.${victim.session.userId}.forged-signature`;
    const attacker = await connect(url, { sessionToken: forged });
    expect(attacker.session.userId).not.toBe(victim.session.userId);
  });
});

describe("room lifecycle", () => {
  it("create -> join -> leave, dengan event notifikasi ke member lain", async () => {
    const { url } = await startServer();
    const host = await connect(url, { name: "Host" });
    const guest = await connect(url, { name: "Guest" });

    const room = await ok<RoomView>(host, "room:create", { type: "chat", name: "Ruang Santai" });
    expect(room.id).toMatch(/^[A-Z0-9]{6}$/);
    expect(room.hostId).toBe(host.session.userId);
    expect(room.members).toHaveLength(1);

    const joinedEvent = waitFor<{ member: { userId: string } }>(host, "room:member-joined");
    const joined = await ok<RoomView>(guest, "room:join", { roomId: room.id.toLowerCase() });
    expect(joined.members.map((m) => m.name)).toEqual(["Host", "Guest"]);
    expect((await joinedEvent).member.userId).toBe(guest.session.userId);

    const leftEvent = waitFor<{ userId: string; reason: string }>(host, "room:member-left");
    await ok(guest, "room:leave");
    expect(await leftEvent).toMatchObject({ userId: guest.session.userId, reason: "left" });
    expect(await ok(guest, "room:sync")).toBeNull();
  });

  it("menolak join ke room penuh, password salah, dan user yang sudah di room lain", async () => {
    const { url } = await startServer();
    const host = await connect(url);
    const room = await ok<RoomView>(host, "room:create", { type: "chat", maxMembers: 2, password: "rahasia" });

    const a = await connect(url);
    expect(await call(a, "room:join", { roomId: room.id })).toMatchObject({ ok: false, error: { code: "INVALID_PASSWORD" } });
    expect(await call(a, "room:join", { roomId: room.id, password: "salah" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PASSWORD" },
    });
    await ok(a, "room:join", { roomId: room.id, password: "rahasia" });

    const b = await connect(url);
    expect(await call(b, "room:join", { roomId: room.id, password: "rahasia" })).toMatchObject({
      ok: false,
      error: { code: "ROOM_FULL" },
    });

    const other = await ok<RoomView>(b, "room:create", { type: "chat" });
    expect(await call(b, "room:join", { roomId: room.id })).toMatchObject({
      ok: false,
      error: { code: "ALREADY_IN_ROOM", details: { roomId: other.id } },
    });
    expect(await call(b, "room:join", { roomId: "ZZZZZZ" })).toMatchObject({ ok: false, error: { code: "ALREADY_IN_ROOM" } });
  });

  it("validasi input dan room tidak dikenal", async () => {
    const { url } = await startServer();
    const user = await connect(url);
    expect(await call(user, "room:create", { maxMembers: "banyak" })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(await call(user, "room:create", { type: "tidak-ada" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_ROOM_TYPE" } });
    expect(await call(user, "room:join", { roomId: "ABCDEF" })).toMatchObject({ ok: false, error: { code: "ROOM_NOT_FOUND" } });
    expect(await call(user, "room:leave")).toMatchObject({ ok: false, error: { code: "NOT_IN_ROOM" } });
  });

  it("join ulang ke room yang sama bersifat idempotent", async () => {
    const { url } = await startServer();
    const host = await connect(url);
    const room = await ok<RoomView>(host, "room:create", {});
    const again = await ok<RoomView>(host, "room:join", { roomId: room.id });
    expect(again.members).toHaveLength(1);
  });
});

describe("hak host", () => {
  it("hanya host yang bisa kick; member yang di-kick menerima room:kicked", async () => {
    const { url } = await startServer();
    const host = await connect(url);
    const a = await connect(url);
    const b = await connect(url);
    const room = await ok<RoomView>(host, "room:create", {});
    await ok(a, "room:join", { roomId: room.id });
    await ok(b, "room:join", { roomId: room.id });

    expect(await call(a, "room:kick", { userId: b.session.userId })).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });

    const kicked = waitFor(b, "room:kicked");
    await ok(host, "room:kick", { userId: b.session.userId });
    await kicked;
    expect(await ok(b, "room:sync")).toBeNull();
  });

  it("transfer host dan update settings", async () => {
    const { url } = await startServer();
    const host = await connect(url);
    const a = await connect(url);
    const room = await ok<RoomView>(host, "room:create", { type: "number-guess" });
    await ok(a, "room:join", { roomId: room.id });

    const updated = await ok<RoomView>(host, "room:update", { isPublic: true, settings: { max: 10 } });
    expect(updated.settings).toEqual({ min: 1, max: 10 });
    expect(await call(host, "room:update", { settings: { max: 0 } })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });

    const changed = waitFor<{ hostId: string }>(a, "room:host-changed");
    await ok(host, "room:transfer-host", { userId: a.session.userId });
    expect((await changed).hostId).toBe(a.session.userId);
    expect(await call(host, "room:update", { isPublic: false })).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
  });

  it("host keluar: policy migrate memindahkan host ke member paling lama", async () => {
    const { url } = await startServer({ HOST_LEAVE_POLICY: "migrate" });
    const host = await connect(url);
    const a = await connect(url);
    const b = await connect(url);
    const room = await ok<RoomView>(host, "room:create", { type: "chat" });
    await ok(a, "room:join", { roomId: room.id });
    await ok(b, "room:join", { roomId: room.id });

    const changed = waitFor<{ hostId: string }>(b, "room:host-changed");
    await ok(host, "room:leave");
    expect((await changed).hostId).toBe(a.session.userId);
  });

  it("host keluar: policy close menutup room untuk semua", async () => {
    const { url } = await startServer({ HOST_LEAVE_POLICY: "close" });
    const host = await connect(url);
    const a = await connect(url);
    const room = await ok<RoomView>(host, "room:create", { type: "chat" });
    await ok(a, "room:join", { roomId: room.id });

    const closed = waitFor<{ reason: string }>(a, "room:closed");
    await ok(host, "room:leave");
    expect((await closed).reason).toBe("host-left");
    expect(await ok(a, "room:sync")).toBeNull();
  });
});

describe("masalah jaringan / reconnect", () => {
  it("koneksi putus lalu kembali dalam masa tunggu: otomatis masuk lagi ke room", async () => {
    const { url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
    const host = await connect(url);
    const player = await connect(url, { name: "Player" });
    const room = await ok<RoomView>(host, "room:create", {});
    await ok(player, "room:join", { roomId: room.id });

    const offline = waitFor<{ userId: string; isConnected: boolean }>(host, "room:member-presence", (e) => !e.isConnected);
    player.disconnect();
    expect((await offline).userId).toBe(player.session.userId);

    const online = waitFor<{ isConnected: boolean }>(host, "room:member-presence", (e) => e.isConnected);
    const back = await connect(url, { sessionToken: player.session.sessionToken! });
    expect(back.session.roomId).toBe(room.id);
    await online;

    // Socket baru langsung menerima event room tanpa emit "rejoin".
    const joined = waitFor(back, "room:member-joined");
    const newcomer = await connect(url);
    await ok(newcomer, "room:join", { roomId: room.id });
    await joined;
  });

  it("masa tunggu habis: member dikeluarkan dengan reason timeout", async () => {
    const { url } = await startServer({ RECONNECT_GRACE_MS: "200" });
    const host = await connect(url);
    const player = await connect(url);
    const room = await ok<RoomView>(host, "room:create", {});
    await ok(player, "room:join", { roomId: room.id });

    const left = waitFor<{ reason: string }>(host, "room:member-left");
    player.disconnect();
    expect((await left).reason).toBe("timeout");

    const back = await connect(url, { sessionToken: player.session.sessionToken! });
    expect(back.session.roomId).toBeNull();
  });

  it("user dengan dua tab: menutup satu tab tidak membuatnya offline", async () => {
    const { url } = await startServer({ RECONNECT_GRACE_MS: "100" });
    const host = await connect(url);
    const tab1 = await connect(url);
    const tab2 = await connect(url, { sessionToken: tab1.session.sessionToken! });
    const room = await ok<RoomView>(host, "room:create", {});
    await ok(tab1, "room:join", { roomId: room.id });

    tab1.disconnect();
    await sleep(300);
    const view = await ok<RoomView>(tab2, "room:sync");
    expect(view.members.find((m) => m.userId === tab2.session.userId)?.isConnected).toBe(true);
  });
});

describe("module: chat", () => {
  it("broadcast pesan dan menyimpan riwayat untuk member yang baru masuk", async () => {
    const { url } = await startServer();
    const host = await connect(url, { name: "Host" });
    const a = await connect(url);
    const room = await ok<RoomView>(host, "room:create", { type: "chat" });
    await ok(a, "room:join", { roomId: room.id });

    const received = waitFor<{ event: string; data: { text: string } }>(a, "room:event", (e) => e.event === "chat:message");
    await ok(host, "room:action", { action: "send", payload: { text: "  halo\u200b semua  " } });
    expect((await received).data.text).toBe("halo semua");

    expect(await call(host, "room:action", { action: "send", payload: { text: "" } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(await call(host, "room:action", { action: "terbang" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_ACTION" } });

    const late = await connect(url);
    const view = await ok<RoomView<{ messages: { text: string }[] }>>(late, "room:join", { roomId: room.id });
    expect(view.state.messages.map((m) => m.text)).toContain("halo semua");
  });
});

describe("module: number-guess", () => {
  it("rahasia tersembunyi, room terkunci selama game, dan pemenang ditentukan", async () => {
    const { url } = await startServer();
    const host = await connect(url);
    const a = await connect(url);
    const room = await ok<RoomView>(host, "room:create", { type: "number-guess", settings: { min: 1, max: 4 } });

    expect(await call(host, "room:action", { action: "start" })).toMatchObject({ ok: false, error: { code: "NOT_ENOUGH_PLAYERS" } });
    await ok(a, "room:join", { roomId: room.id });
    expect(await call(a, "room:action", { action: "start" })).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });

    await ok(host, "room:action", { action: "start" });
    const view = await ok<RoomView<{ secret: number | null; phase: string }>>(a, "room:sync");
    expect(view.locked).toBe(true);
    expect(view.state.phase).toBe("playing");
    expect(view.state.secret).toBeNull();

    const outsider = await connect(url);
    expect(await call(outsider, "room:join", { roomId: room.id })).toMatchObject({ ok: false, error: { code: "ROOM_LOCKED" } });

    const finished = waitFor<{ event: string; data: { winnerId: string } }>(host, "room:event", (e) => e.event === "game:finished");
    for (let value = 1; value <= 4; value++) {
      const result = await ok<{ hint: string }>(a, "room:action", { action: "guess", payload: { value } });
      if (result.hint === "correct") break;
    }
    expect((await finished).data.winnerId).toBe(a.session.userId);

    const after = await ok<RoomView<{ secret: number | null }>>(host, "room:sync");
    expect(after.locked).toBe(false);
    expect(after.state.secret).toBeGreaterThanOrEqual(1);
  });
});

describe("HTTP API", () => {
  it("health, daftar room publik, dan ringkasan room", async () => {
    const { url } = await startServer();
    const host = await connect(url, { name: "Host" });
    const publicRoom = await ok<RoomView>(host, "room:create", { isPublic: true, name: "Publik" });
    const other = await connect(url);
    await ok(other, "room:create", { isPublic: false });

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");

    const list = (await (await fetch(`${url}/api/rooms`)).json()) as { data: RoomSummary[] };
    expect(list.data.map((r) => r.id)).toEqual([publicRoom.id]);

    const summary = (await (await fetch(`${url}/api/rooms/${publicRoom.id}`)).json()) as { data: RoomSummary };
    expect(summary.data).toMatchObject({ hostName: "Host", memberCount: 1, hasPassword: false });

    const missing = await fetch(`${url}/api/rooms/NOPE00`);
    expect(missing.status).toBe(404);
  });
});

describe("JWT auth", () => {
  const secret = "test-secret-yang-panjangnya-minimal-32-karakter";

  it("menerima token valid dan menolak token tidak valid / tidak ada", async () => {
    const { url } = await startServer({ AUTH_MODE: "jwt", JWT_SECRET: secret });
    const token = await new SignJWT({ name: "Siti", email: "siti@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-123")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(secret));

    const client = await connect(url, { token });
    expect(client.session).toMatchObject({ userId: "user-123", name: "Siti", sessionToken: null });

    await expect(connect(url, { token: `${token}x` })).rejects.toThrow("UNAUTHORIZED");
    await expect(connect(url)).rejects.toThrow("UNAUTHORIZED");
  });
});

describe("rate limit socket", () => {
  it("membalas RATE_LIMITED saat event terlalu banyak", async () => {
    const { url } = await startServer({ SOCKET_RATE_LIMIT_MAX: "3", SOCKET_RATE_LIMIT_WINDOW_MS: "10000" });
    const user = await connect(url);
    const responses = await Promise.all(Array.from({ length: 5 }, () => call(user, "room:sync")));
    expect(responses.filter((r) => !r.ok && r.error.code === "RATE_LIMITED")).toHaveLength(2);
  });
});
