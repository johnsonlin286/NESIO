import type { IncomingHttpHeaders } from "node:http";
import type { Identity } from "../core/types.js";
import type { HandshakeAuth } from "../shared/contract.js";

export interface AuthInput {
  auth: HandshakeAuth;
  headers: IncomingHttpHeaders;
  ip: string;
}

export interface AuthResult {
  identity: Identity;
  /** Token yang dikembalikan ke client (mode guest). */
  sessionToken: string | null;
}

/**
 * Fungsi yang menentukan siapa user dari data handshake Socket.IO.
 * Lempar error untuk menolak koneksi (client menerima `connect_error`).
 *
 * Bisa diganti dengan implementasi sendiri, mis. verifikasi Firebase ID token
 * atau session database, lalu dikirim ke `createRoomServer({ authenticator })`.
 */
export type Authenticator = (input: AuthInput) => Promise<AuthResult>;
