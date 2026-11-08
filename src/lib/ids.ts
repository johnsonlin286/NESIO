import { randomInt, randomUUID } from "node:crypto";

// Tanpa karakter yang mirip (0/O, 1/I/L) supaya kode room mudah diketik.
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRoomCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generateUserId(): string {
  return randomUUID();
}
