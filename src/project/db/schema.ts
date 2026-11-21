import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Akun aplikasi Android (login Google). Pemain web tetap guest dan tidak punya baris di sini.
 * Data seminimal mungkin: id Google (`sub`) untuk login, email untuk kontak/dukungan.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email"),
  /** Nama pemain pilihan sendiri; diisi di aplikasi setelah login pertama. */
  displayName: text("display_name"),
  ...timestamps,
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Refresh token: yang disimpan hanya hash SHA-256-nya. Setiap refresh memakai token sekali
 * (`used_at`) lalu menerbitkan token baru di family yang sama (rotation). Token yang dipakai
 * ulang berarti bocor, jadi seluruh family dicabut (`revoked_at`).
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("refresh_tokens_user_idx").on(table.userId),
    index("refresh_tokens_family_idx").on(table.familyId),
    index("refresh_tokens_expires_idx").on(table.expiresAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
