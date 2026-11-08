import { z } from "zod";
import { cleanText } from "../lib/text.js";
import type { HandshakeAuth } from "../shared/contract.js";

export const displayNameSchema = z
  .string()
  .transform(cleanText)
  .pipe(z.string().min(1, "Nama tidak boleh kosong").max(32, "Nama maksimal 32 karakter"));

export const avatarSchema = z.string().trim().min(1).max(512);

const handshakeSchema = z.object({
  token: z.string().max(8192).optional(),
  sessionToken: z.string().max(512).optional(),
  name: displayNameSchema.optional(),
  avatar: avatarSchema.optional(),
});

/** Data handshake tidak valid diabaikan (bukan ditolak) supaya client lama tetap bisa connect. */
export function parseHandshakeAuth(raw: unknown): HandshakeAuth {
  const result = handshakeSchema.safeParse(raw ?? {});
  return result.success ? result.data : {};
}
