import type { MemberRole } from "../shared/contract.js";

/** Siapa user ini, hasil dari authenticator. */
export interface Identity {
  /** ID stabil (tidak berubah saat reconnect). Bukan socket.id! */
  userId: string;
  name: string;
  avatar: string | null;
  /** Data tambahan dari JWT / provider auth (mis. email, roles). Tidak dikirim ke client lain. */
  claims?: Record<string, unknown>;
}

export interface Member {
  userId: string;
  name: string;
  avatar: string | null;
  role: MemberRole;
  isConnected: boolean;
  joinedAt: number;
  disconnectedAt: number | null;
}

/**
 * Data room yang disimpan di store. Harus bisa di-`structuredClone`
 * (tanpa function/class instance) supaya bisa dipindah ke Redis nantinya.
 */
export interface Room<TState = unknown, TSettings = Record<string, unknown>> {
  id: string;
  type: string;
  name: string | null;
  hostId: string;
  isPublic: boolean;
  passwordHash: string | null;
  locked: boolean;
  maxMembers: number;
  members: Member[];
  settings: TSettings;
  state: TState;
  createdAt: number;
  updatedAt: number;
}
