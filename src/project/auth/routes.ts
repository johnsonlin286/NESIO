import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { AppError, Errors } from "../../lib/errors.js";
import { parseOrThrow } from "../../lib/validation.js";
import { INAPPROPRIATE_NAME, INVALID_NAME, isInappropriateName, isValidPlayerName, NAME_TAKEN } from "../player-names.js";
import type { AuthService } from "./service.js";

const googleLoginSchema = z.object({ idToken: z.string().min(1).max(4096) });
const refreshTokenSchema = z.object({ refreshToken: z.string().min(1).max(256) });
const displayNameSchema = z.object({ name: z.string().trim().max(64) });

export interface AuthRouterOptions {
  /** True kalau pemain LAIN sedang online dengan nama ini (tamu web, atau masih di room). */
  nameInUse?: (name: string, userId: string) => Promise<boolean>;
}

function bearerToken(req: Request): string {
  const header = req.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw Errors.unauthorized("Access token wajib dikirim");
  return token;
}

/**
 * /api/auth untuk aplikasi Android. Tanpa `service` (DATABASE_URL kosong) semua endpoint menjawab
 * 503, supaya server tetap bisa dipakai pemain web.
 */
export function authRouter(service: AuthService | null, { nameInUse }: AuthRouterOptions = {}): Router {
  const router = Router();

  router.use((_req, res, next) => {
    // Token tidak boleh tersimpan di cache mana pun.
    res.set("Cache-Control", "no-store");
    if (!service) {
      res.status(503).json({ ok: false, error: { code: "AUTH_DISABLED", message: "Login aplikasi belum aktif di server ini" } });
      return;
    }
    next();
  });
  if (!service) return router;

  // Login memanggil verifikasi Google dan menulis ke database: dibatasi lebih ketat dari /api umum.
  // Longgar per IP karena banyak pengguna seluler di balik satu IP operator (CGNAT).
  const loginLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ ok: false, error: Errors.rateLimited().toPayload() });
    },
  });

  router.post("/google", loginLimit, async (req, res) => {
    const { idToken } = parseOrThrow(googleLoginSchema, req.body);
    res.json({ ok: true, data: await service.loginWithGoogle(idToken) });
  });

  router.post("/refresh", async (req, res) => {
    const { refreshToken } = parseOrThrow(refreshTokenSchema, req.body);
    res.json({ ok: true, data: await service.refresh(refreshToken) });
  });

  router.post("/logout", async (req, res) => {
    const { refreshToken } = parseOrThrow(refreshTokenSchema, req.body);
    await service.logout(refreshToken);
    res.json({ ok: true, data: null });
  });

  router.get("/me", async (req, res) => {
    const userId = await service.verifyAccessToken(bearerToken(req));
    const user = await service.getUser(userId);
    if (!user) throw Errors.unauthorized("Akun tidak ditemukan");
    res.json({ ok: true, data: user });
  });

  /** Pilih atau ganti nama pemain milik akun (aturan sama dengan handshake, lihat player-names.ts). */
  router.put("/me/name", async (req, res) => {
    const userId = await service.verifyAccessToken(bearerToken(req));
    const { name } = parseOrThrow(displayNameSchema, req.body);
    if (!isValidPlayerName(name)) throw new AppError(INVALID_NAME, "Nama 3–20 karakter: huruf, angka, _ atau -.");
    if (isInappropriateName(name)) throw new AppError(INAPPROPRIATE_NAME, "Nama mengandung kata yang tidak pantas.");
    if (await nameInUse?.(name, userId)) {
      throw new AppError(NAME_TAKEN, "Nama ini sedang dipakai pemain lain. Pilih nama lain.");
    }
    res.json({ ok: true, data: await service.setDisplayName(userId, name) });
  });

  router.delete("/me", async (req, res) => {
    const userId = await service.verifyAccessToken(bearerToken(req));
    await service.deleteAccount(userId);
    res.json({ ok: true, data: null });
  });

  return router;
}
