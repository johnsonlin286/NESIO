import type { RoomStore } from "../core/store/room-store.js";
import type { Room } from "../core/types.js";

/** Gabungkan beberapa perubahan beruntun (mis. leave + pindah host) jadi satu sinyal. */
const BATCH_MS = 50;

/**
 * Hanya field yang tampil di daftar room lobby (`RoomSummary`).
 * Perubahan lain (pesan chat, state game, online/offline) tidak memicu sinyal.
 */
function lobbyFingerprint(room: Room): string {
  const host = room.members.find((m) => m.userId === room.hostId);
  return JSON.stringify([
    room.isPublic,
    room.passwordHash !== null,
    room.locked,
    room.maxMembers,
    room.members.length,
    room.name,
    host?.name ?? null,
  ]);
}

/**
 * Membungkus RoomStore: setiap kali isi daftar room lobby berubah
 * (room dibuat / ditutup, pemain masuk / keluar, host pindah, password / kunci berubah)
 * `onLobbyChanged` dipanggil sekali. Semua perubahan room di core lewat save/delete,
 * jadi core tidak perlu diubah.
 */
export class LobbyAwareRoomStore implements RoomStore {
  private readonly fingerprints = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly inner: RoomStore,
    private readonly onLobbyChanged: () => void,
  ) {}

  get(roomId: string) {
    return this.inner.get(roomId);
  }

  has(roomId: string) {
    return this.inner.has(roomId);
  }

  list() {
    return this.inner.list();
  }

  findRoomIdByUser(userId: string) {
    return this.inner.findRoomIdByUser(userId);
  }

  async save(room: Room): Promise<void> {
    await this.inner.save(room);
    const next = lobbyFingerprint(room);
    if (this.fingerprints.get(room.id) === next) return;
    this.fingerprints.set(room.id, next);
    this.schedule();
  }

  async delete(roomId: string): Promise<void> {
    await this.inner.delete(roomId);
    if (this.fingerprints.delete(roomId)) this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onLobbyChanged();
    }, BATCH_MS);
    this.timer.unref();
  }
}
