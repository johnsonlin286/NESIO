import type { ServerToClientEvents } from "../shared/contract.js";

type EventName = keyof ServerToClientEvents;
type EventArgs<E extends EventName> = Parameters<ServerToClientEvents[E]>;

/**
 * Cara RoomService "berbicara" ke client tanpa bergantung langsung ke Socket.IO.
 * Implementasinya ada di `socket/socket-notifier.ts`.
 */
export interface RoomNotifier {
  toRoom<E extends EventName>(roomId: string, event: E, ...args: EventArgs<E>): void;
  toUser<E extends EventName>(userId: string, event: E, ...args: EventArgs<E>): void;
  /** Masukkan semua koneksi milik user ke channel room. */
  attachUser(userId: string, roomId: string): void;
  /** Keluarkan semua koneksi milik user dari channel room. */
  detachUser(userId: string, roomId: string): void;
}
