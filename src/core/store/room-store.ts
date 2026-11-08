import type { Room } from "../types.js";

/**
 * Abstraksi penyimpanan room. Implementasi default: in-memory.
 * Untuk multi-instance, buat implementasi Redis dengan interface yang sama
 * (lihat README bagian "Scaling").
 *
 * Kontrak: `get` mengembalikan salinan; perubahan baru tersimpan setelah `save`.
 */
export interface RoomStore {
  get(roomId: string): Promise<Room | null>;
  has(roomId: string): Promise<boolean>;
  save(room: Room): Promise<void>;
  delete(roomId: string): Promise<void>;
  list(): Promise<Room[]>;
  /** Room tempat user menjadi member (satu user hanya boleh di satu room). */
  findRoomIdByUser(userId: string): Promise<string | null>;
}
