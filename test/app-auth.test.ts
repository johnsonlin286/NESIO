import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";
import { AuthService, type AppAuth } from "../src/project/auth/index.js";
import { createGoogleVerifier } from "../src/project/auth/google.js";
import { RoomKeyService } from "../src/project/keys/service.js";
import { MIGRATIONS_FOLDER, type Database } from "../src/project/db/client.js";
import * as schema from "../src/project/db/schema.js";
import { createAbcWordsServer } from "../src/project/server.js";
import type { RoomServer } from "../src/server.js";
import type { AuthSession, AuthUser } from "../src/shared/contract.js";
import { cleanup, connect } from "./helpers.js";

const WEB_CLIENT_ID = "test-web.apps.googleusercontent.com";
const HOUR = 60 * 60 * 1000;

let pg: PGlite;
let db: Database;
let googleKey: CryptoKey;
let verifyGoogle: ReturnType<typeof createGoogleVerifier>;
let clock = Date.now();
const servers: RoomServer[] = [];

beforeAll(async () => {
  // Postgres sungguhan (WASM, di dalam proses): migrasi dan query sama dengan production.
  pg = new PGlite();
  const pgliteDb = drizzle({ client: pg, schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb as unknown as Database;

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  googleKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  verifyGoogle = createGoogleVerifier([WEB_CLIENT_ID], createLocalJWKSet({ keys: [jwk] }));
});

afterEach(async () => {
  await cleanup();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await pg.exec("TRUNCATE users, refresh_tokens CASCADE");
  clock = Date.now();
});

afterAll(async () => {
  await pg.close();
});

function newService() {
  return new AuthService({
    db,
    verifyGoogle,
    jwtSecret: "test-app-jwt-secret-at-least-32-characters",
    accessTokenTtlSec: 15 * 60,
    refreshTokenTtlDays: 30,
    now: () => clock,
  });
}

/** ID token seperti dari Google Sign-In, ditandatangani kunci uji. */
function googleIdToken({
  sub = "google-sub-1",
  email = "budi@example.com",
  emailVerified = true,
  audience = WEB_CLIENT_ID,
  issuer = "https://accounts.google.com",
  expiresInSec = 3600,
} = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: emailVerified })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(nowSec - 10)
    .setExpirationTime(nowSec + expiresInSec)
    .sign(googleKey);
}

async function startAuthServer(service: AuthService | null) {
  const config = loadConfig({ NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "silent" });
  const appAuth: AppAuth | null = service && {
    service,
    keys: new RoomKeyService(db, undefined, () => clock),
    close: async () => {},
  };
  const server = createAbcWordsServer(config, createLogger(config), undefined, { appAuth });
  const port = await server.start();
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

async function api<T>(url: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const response = await fetch(`${url}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.body !== undefined && { "content-type": "application/json" }),
      ...(init.token && { authorization: `Bearer ${init.token}` }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, headers: response.headers, json: (await response.json()) as { ok: boolean; data: T; error: { code: string } } };
}

describe("AuthService: login Google", () => {
  it("membuat akun sekali, login berikutnya memakai akun yang sama", async () => {
    const service = newService();
    const first = await service.loginWithGoogle(await googleIdToken());
    const second = await service.loginWithGoogle(await googleIdToken({ email: "budi.baru@example.com" }));

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe("budi.baru@example.com");
    expect(second.user.displayName).toBeNull();
    expect(await service.verifyAccessToken(first.tokens.accessToken)).toBe(first.user.id);
    expect(first.tokens.refreshToken).not.toBe(second.tokens.refreshToken);
  });

  it("menolak token untuk client lain, issuer palsu, kedaluwarsa, dan sampah", async () => {
    const service = newService();
    for (const token of [
      await googleIdToken({ audience: "other-app.apps.googleusercontent.com" }),
      await googleIdToken({ issuer: "https://evil.example.com" }),
      await googleIdToken({ expiresInSec: -60 }),
      "bukan.jwt.sama-sekali",
    ]) {
      await expect(service.loginWithGoogle(token)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("email yang belum diverifikasi Google tidak disimpan", async () => {
    const { user } = await newService().loginWithGoogle(await googleIdToken({ emailVerified: false }));
    expect(user.email).toBeNull();
  });
});

describe("AuthService: refresh token", () => {
  it("rotasi: token baru berlaku, token lama tidak", async () => {
    const service = newService();
    const login = await service.loginWithGoogle(await googleIdToken());
    const refreshed = await service.refresh(login.tokens.refreshToken);

    expect(refreshed.user.id).toBe(login.user.id);
    expect(refreshed.tokens.refreshToken).not.toBe(login.tokens.refreshToken);
    await expect(service.refresh(refreshed.tokens.refreshToken)).resolves.toBeTruthy();
  });

  it("token lama yang dipakai lagi mencabut seluruh family (token curian)", async () => {
    const service = newService();
    const login = await service.loginWithGoogle(await googleIdToken());
    const refreshed = await service.refresh(login.tokens.refreshToken);

    await expect(service.refresh(login.tokens.refreshToken)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Pemilik sah juga harus login ulang: kita tidak tahu siapa yang memegang token terbaru.
    await expect(service.refresh(refreshed.tokens.refreshToken)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("dua refresh bersamaan dengan token yang sama: paling banyak satu berhasil", async () => {
    const service = newService();
    const login = await service.loginWithGoogle(await googleIdToken());
    const results = await Promise.allSettled([
      service.refresh(login.tokens.refreshToken),
      service.refresh(login.tokens.refreshToken),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
  });

  it("logout mencabut sesi perangkat itu saja", async () => {
    const service = newService();
    const phone = await service.loginWithGoogle(await googleIdToken());
    const tablet = await service.loginWithGoogle(await googleIdToken());

    await service.logout(phone.tokens.refreshToken);
    await service.logout(phone.tokens.refreshToken); // idempotent
    await expect(service.refresh(phone.tokens.refreshToken)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(service.refresh(tablet.tokens.refreshToken)).resolves.toBeTruthy();
  });

  it("token kedaluwarsa ditolak lalu dibersihkan", async () => {
    const service = newService();
    const login = await service.loginWithGoogle(await googleIdToken());

    clock += 31 * 24 * HOUR;
    await expect(service.refresh(login.tokens.refreshToken)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await service.pruneExpired()).toBe(1);
  });

  it("access token kedaluwarsa ditolak", async () => {
    const service = newService();
    clock = Date.now() - 2 * HOUR; // ditandatangani 2 jam lalu, berlaku 15 menit
    const login = await service.loginWithGoogle(await googleIdToken());
    await expect(service.verifyAccessToken(login.tokens.accessToken)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("hapus akun menghapus semua sesinya", async () => {
    const service = newService();
    const login = await service.loginWithGoogle(await googleIdToken());

    await service.deleteAccount(login.user.id);
    expect(await service.getUser(login.user.id)).toBeNull();
    await expect(service.refresh(login.tokens.refreshToken)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Login lagi dengan akun Google yang sama = akun baru.
    const again = await service.loginWithGoogle(await googleIdToken());
    expect(again.user.id).not.toBe(login.user.id);
  });
});

describe("/api/auth dan handshake Socket.IO", () => {
  it("login, /me, refresh, logout lewat HTTP", async () => {
    const url = await startAuthServer(newService());

    const login = await api<AuthSession>(url, "/api/auth/google", { body: { idToken: await googleIdToken() } });
    expect(login.status).toBe(200);
    expect(login.headers.get("cache-control")).toBe("no-store");
    const { tokens, user } = login.json.data;

    const me = await api<AuthUser>(url, "/api/auth/me", { token: tokens.accessToken });
    expect(me.json.data.id).toBe(user.id);
    expect((await api(url, "/api/auth/me")).status).toBe(401);
    expect((await api(url, "/api/auth/me", { token: "salah" })).status).toBe(401);

    const refreshed = await api<AuthSession>(url, "/api/auth/refresh", { body: { refreshToken: tokens.refreshToken } });
    expect(refreshed.status).toBe(200);
    expect((await api(url, "/api/auth/refresh", { body: { refreshToken: tokens.refreshToken } })).status).toBe(401);

    expect((await api(url, "/api/auth/logout", { body: { refreshToken: refreshed.json.data.tokens.refreshToken } })).status).toBe(200);
  });

  it("validasi input dan login Google yang tidak valid", async () => {
    const url = await startAuthServer(newService());
    expect((await api(url, "/api/auth/google", { body: {} })).json.error.code).toBe("VALIDATION_ERROR");
    expect((await api(url, "/api/auth/google", { body: { idToken: "palsu" } })).status).toBe(401);
  });

  it("aplikasi connect dengan access token; web tetap guest", async () => {
    const service = newService();
    const url = await startAuthServer(service);
    const { user, tokens } = await service.loginWithGoogle(await googleIdToken());

    // Belum memilih nama: belum boleh main.
    await expect(connect(url, { token: tokens.accessToken, name: "Budi" })).rejects.toThrow("INVALID_NAME");
    await service.setDisplayName(user.id, "Budi");
    const app = await connect(url, { token: tokens.accessToken });
    expect(app.session.userId).toBe(user.id);
    expect(app.session.name).toBe("Budi");
    expect(app.session.sessionToken).toBeNull();

    const web = await connect(url, { name: "Sari" });
    expect(web.session.sessionToken).toBeTruthy();

    await expect(connect(url, { token: "token-palsu", name: "Joko" })).rejects.toThrow();
  });

  it("akun yang dihapus tidak bisa connect lagi walaupun access token belum kedaluwarsa", async () => {
    const service = newService();
    const url = await startAuthServer(service);
    const { user, tokens } = await service.loginWithGoogle(await googleIdToken());
    await service.setDisplayName(user.id, "Budi");

    expect((await api(url, "/api/auth/me", { method: "DELETE", token: tokens.accessToken })).status).toBe(200);
    await expect(connect(url, { token: tokens.accessToken, name: "Budi" })).rejects.toThrow();
    expect((await api(url, "/api/auth/me", { token: tokens.accessToken })).status).toBe(401);
  });

  it("tanpa database: /api/auth menjawab 503, token ditolak, guest tetap jalan", async () => {
    const url = await startAuthServer(null);
    const response = await api(url, "/api/auth/google", { body: { idToken: "x" } });
    expect(response.status).toBe(503);
    expect(response.json.error.code).toBe("AUTH_DISABLED");
    await expect(connect(url, { token: "apa-saja", name: "Budi" })).rejects.toThrow();
    expect((await connect(url, { name: "Sari" })).session.userId).toBeTruthy();
  });
});

describe("nama pemain milik akun", () => {
  async function signedIn(url: string, sub: string) {
    const login = await api<AuthSession>(url, "/api/auth/google", { body: { idToken: await googleIdToken({ sub }) } });
    return login.json.data.tokens.accessToken;
  }
  const setName = (url: string, token: string, name: string) =>
    api<AuthUser>(url, "/api/auth/me/name", { method: "PUT", body: { name }, token });

  it("menyimpan nama, menolak nama tidak valid dan kasar", async () => {
    const url = await startAuthServer(newService());
    const token = await signedIn(url, "google-a");

    const saved = await setName(url, token, "Budi_90");
    expect(saved.status).toBe(200);
    expect(saved.json.data.displayName).toBe("Budi_90");
    expect((await setName(url, token, "Budi_90")).status).toBe(200); // nama sendiri boleh disimpan lagi

    expect((await setName(url, token, "ab")).json.error.code).toBe("INVALID_NAME");
    expect((await setName(url, token, "nama spasi")).json.error.code).toBe("INVALID_NAME");
    expect((await setName(url, token, "kontol123")).json.error.code).toBe("INAPPROPRIATE_NAME");
    expect((await api(url, "/api/auth/me/name", { method: "PUT", body: { name: "Budi" } })).status).toBe(401);
  });

  it("nama unik tanpa membedakan huruf besar/kecil", async () => {
    const url = await startAuthServer(newService());
    const a = await signedIn(url, "google-a");
    const b = await signedIn(url, "google-b");

    expect((await setName(url, a, "Budi")).status).toBe(200);
    expect((await setName(url, b, "bUDI")).json.error.code).toBe("NAME_TAKEN");
    // Setelah A ganti nama, "Budi" bebas lagi.
    expect((await setName(url, a, "Budiman")).status).toBe(200);
    expect((await setName(url, b, "budi")).status).toBe(200);
  });

  it("tamu web tidak bisa memakai nama milik akun; pemilik akun memakai namanya", async () => {
    const service = newService();
    const url = await startAuthServer(service);
    const { user, tokens } = await service.loginWithGoogle(await googleIdToken());
    await service.setDisplayName(user.id, "Budi");

    await expect(connect(url, { name: "budi" })).rejects.toThrow("NAME_TAKEN");
    const app = await connect(url, { token: tokens.accessToken, name: "NamaLain" });
    expect(app.session.name).toBe("Budi");
    expect((await connect(url, { name: "Sari" })).session.userId).toBeTruthy();
  });

  it("tidak bisa mengambil nama yang sedang dipakai tamu online", async () => {
    const url = await startAuthServer(newService());
    await connect(url, { name: "Joko" });
    const token = await signedIn(url, "google-a");
    expect((await setName(url, token, "joko")).json.error.code).toBe("NAME_TAKEN");
  });
});

describe("/api/auth/me/keys", () => {
  it("akun baru punya kunci penuh; butuh login", async () => {
    const url = await startAuthServer(newService());
    const login = await api<AuthSession>(url, "/api/auth/google", { body: { idToken: await googleIdToken() } });
    const keys = await api<{ count: number; max: number; nextAt: number | null }>(url, "/api/auth/me/keys", {
      token: login.json.data.tokens.accessToken,
    });
    expect(keys.json.data).toMatchObject({ count: 5, max: 5, nextAt: null });
    expect((await api(url, "/api/auth/me/keys")).status).toBe(401);
  });
});
