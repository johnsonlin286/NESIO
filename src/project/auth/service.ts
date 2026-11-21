import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { AppError, Errors } from "../../lib/errors.js";
import type { AuthSession, AuthTokens, AuthUser } from "../../shared/contract.js";
import type { Database } from "../db/client.js";
import { refreshTokens, users, type UserRow } from "../db/schema.js";
import { NAME_TAKEN } from "../player-names.js";
import type { GoogleVerifier } from "./google.js";
import { generateRefreshToken, hashRefreshToken, secretKey, signAccessToken, verifyAccessToken } from "./tokens.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthServiceOptions {
  db: Database;
  verifyGoogle: GoogleVerifier;
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlDays: number;
  now?: () => number;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Login aplikasi Android: Google ID token ditukar dengan sesi milik kita sendiri
 * (access token JWT pendek + refresh token yang dirotasi).
 */
export class AuthService {
  private readonly db: Database;
  private readonly verifyGoogle: GoogleVerifier;
  private readonly key: Uint8Array;
  private readonly accessTtlSec: number;
  private readonly refreshTtlMs: number;
  private readonly now: () => number;

  constructor(options: AuthServiceOptions) {
    this.db = options.db;
    this.verifyGoogle = options.verifyGoogle;
    this.key = secretKey(options.jwtSecret);
    this.accessTtlSec = options.accessTokenTtlSec;
    this.refreshTtlMs = options.refreshTokenTtlDays * DAY_MS;
    this.now = options.now ?? Date.now;
  }

  /** Login pertama membuat akun; login berikutnya memakai akun yang sama (berdasarkan `sub` Google). */
  async loginWithGoogle(idToken: string): Promise<AuthSession> {
    const profile = await this.verifyGoogle(idToken);
    const now = new Date(this.now());
    const [user] = await this.db
      .insert(users)
      .values({ googleSub: profile.sub, email: profile.email, lastLoginAt: now })
      .onConflictDoUpdate({
        target: users.googleSub,
        set: { lastLoginAt: now, ...(profile.email && { email: profile.email }) },
      })
      .returning();
    if (!user) throw Errors.internal();
    const tokens = await this.issueTokens(this.db, user.id, randomUUID());
    return { user: toAuthUser(user), tokens };
  }

  /**
   * Tukar refresh token dengan pasangan token baru. Token lama ditandai terpakai secara atomik,
   * jadi dua permintaan bersamaan dengan token yang sama tidak bisa sama-sama berhasil.
   * Token yang sudah pernah dipakai lalu dikirim lagi = bocor: seluruh family dicabut.
   */
  async refresh(refreshToken: string): Promise<AuthSession> {
    const tokenHash = hashRefreshToken(refreshToken);
    const now = new Date(this.now());

    const session = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(refreshTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.usedAt),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, now),
          ),
        )
        .returning({ userId: refreshTokens.userId, familyId: refreshTokens.familyId });
      if (!claimed) return null;

      const [user] = await tx.select().from(users).where(eq(users.id, claimed.userId));
      if (!user) return null;
      return { user: toAuthUser(user), tokens: await this.issueTokens(tx, user.id, claimed.familyId) };
    });
    if (session) return session;

    // Di luar transaksi supaya pencabutan tetap tersimpan walaupun permintaan ini ditolak.
    const [reused] = await this.db
      .select({ familyId: refreshTokens.familyId, usedAt: refreshTokens.usedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash));
    if (reused?.usedAt) await this.revokeFamily(reused.familyId, now);
    throw Errors.unauthorized("Sesi berakhir, silakan masuk lagi");
  }

  /** Logout: cabut family token ini (sesi di perangkat ini saja). Selalu berhasil. */
  async logout(refreshToken: string): Promise<void> {
    const [row] = await this.db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));
    if (row) await this.revokeFamily(row.familyId, new Date(this.now()));
  }

  /** Hapus akun beserta semua sesinya (cascade). Wajib tersedia menurut kebijakan Play Store. */
  async deleteAccount(userId: string): Promise<void> {
    if (!UUID_PATTERN.test(userId)) return;
    await this.db.delete(users).where(eq(users.id, userId));
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    if (!UUID_PATTERN.test(userId)) return null;
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    return user ? toAuthUser(user) : null;
  }

  /**
   * Simpan nama pemain milik akun. Validasi format dan kata kasar dilakukan pemanggil (route).
   * Unik tanpa membedakan huruf besar/kecil; indeks unik di database menutup race dua akun
   * yang memilih nama sama bersamaan.
   */
  async setDisplayName(userId: string, name: string): Promise<AuthUser> {
    const owner = await this.findUserIdByName(name);
    if (owner && owner !== userId) throw nameTaken();
    try {
      const [user] = await this.db.update(users).set({ displayName: name }).where(eq(users.id, userId)).returning();
      if (!user) throw Errors.unauthorized("Akun tidak ditemukan");
      return toAuthUser(user);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /** Akun pemilik nama ini (tanpa membedakan huruf besar/kecil), atau null. */
  async findUserIdByName(name: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.displayName})`, name.toLowerCase()));
    return row?.id ?? null;
  }

  /** Id user dari access token; UNAUTHORIZED kalau tidak valid atau kedaluwarsa. */
  verifyAccessToken(token: string): Promise<string> {
    return verifyAccessToken(token, this.key);
  }

  /** Buang refresh token yang sudah kedaluwarsa (tidak berguna lagi, termasuk untuk deteksi reuse). */
  async pruneExpired(): Promise<number> {
    const deleted = await this.db
      .delete(refreshTokens)
      .where(lt(refreshTokens.expiresAt, new Date(this.now())))
      .returning({ id: refreshTokens.id });
    return deleted.length;
  }

  private async issueTokens(db: Database | Tx, userId: string, familyId: string): Promise<AuthTokens> {
    const now = this.now();
    const access = await signAccessToken(userId, this.key, this.accessTtlSec, now);
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = now + this.refreshTtlMs;
    await db.insert(refreshTokens).values({
      userId,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(refreshExpiresAt),
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }
}

function nameTaken(): AppError {
  return new AppError(NAME_TAKEN, "Nama ini sudah dipakai pemain lain. Pilih nama lain.");
}

/** Postgres unique_violation (23505), langsung dari driver atau dibungkus Drizzle (`cause`). */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

function toAuthUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.getTime(),
  };
}
