import type { Logger } from "../lib/logger.js";
import type { PresenceResult, RoomService } from "./room-service.js";

/**
 * Melacak berapa koneksi aktif tiap user (user bisa buka beberapa tab/device)
 * dan menangani masa tunggu reconnect.
 *
 * Alur saat jaringan putus:
 *   1. Koneksi terakhir user putus -> member ditandai offline, room diberi tahu.
 *   2. Timer RECONNECT_GRACE_MS dimulai.
 *   3a. User connect lagi sebelum timer habis -> timer batal, member online lagi,
 *       socket otomatis masuk kembali ke room (tanpa perlu event "rejoin").
 *   3b. Timer habis -> member dikeluarkan dengan reason "timeout".
 */
export class PresenceTracker {
  private readonly connections = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly logger: Logger;

  constructor(
    private readonly rooms: RoomService,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "presence" });
  }

  isOnline(userId: string): boolean {
    return (this.connections.get(userId) ?? 0) > 0;
  }

  async connected(userId: string): Promise<PresenceResult | null> {
    this.connections.set(userId, (this.connections.get(userId) ?? 0) + 1);
    this.clearTimer(userId);
    return this.rooms.syncPresence(userId, () => this.isOnline(userId));
  }

  async disconnected(userId: string): Promise<void> {
    const remaining = (this.connections.get(userId) ?? 1) - 1;
    if (remaining > 0) {
      this.connections.set(userId, remaining);
      return;
    }
    this.connections.delete(userId);

    const presence = await this.rooms.syncPresence(userId, () => this.isOnline(userId));
    if (!presence || this.isOnline(userId)) return;

    this.clearTimer(userId);
    const timer = setTimeout(() => {
      this.timers.delete(userId);
      if (this.isOnline(userId)) return;
      this.rooms.expireDisconnected(userId).catch((error: unknown) => {
        this.logger.error({ err: error, userId }, "failed to expire disconnected member");
      });
    }, presence.reconnectGraceMs);
    timer.unref();
    this.timers.set(userId, timer);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private clearTimer(userId: string): void {
    const timer = this.timers.get(userId);
    if (timer) clearTimeout(timer);
    this.timers.delete(userId);
  }
}
