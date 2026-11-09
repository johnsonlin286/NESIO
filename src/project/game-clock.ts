import type { RoomService } from "../core/room-service.js";
import type { RoomStore } from "../core/store/room-store.js";
import type { Room } from "../core/types.js";
import { AppError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { isPhaseDue, ROOM_TYPE } from "../modules/abc-words/index.js";

const INTERVAL_MS = 200;

export interface GameClockDeps {
  store: RoomStore;
  rooms: RoomService;
  logger: Logger;
  /** Lama host boleh offline sebelum perannya pindah ke pemain lain yang online. */
  hostAwayMs: number;
}

/**
 * Memeriksa semua room game secara berkala (NESIO belum punya timer di sisi server):
 * - fase yang deadline-nya lewat dimajukan lewat aksi `tick`
 * - host yang offline terlalu lama digantikan pemain lain, jauh sebelum kursinya hilang
 *   (masa tunggu reconnect), supaya room tidak tertahan tanpa host
 *
 * Keduanya memakai jalur biasa di RoomService (mutex per room, validasi, broadcast).
 * Mengembalikan fungsi untuk menghentikan jam.
 */
export function startGameClock(deps: GameClockDeps): () => void {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runChecks(deps).finally(() => {
      running = false;
    });
  }, INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}

/** Pemain online yang paling lama di room, kalau host sudah offline melewati batas. */
export function replacementForAwayHost(room: Room, now: number, hostAwayMs: number): string | null {
  if (room.type !== ROOM_TYPE) return null;
  const host = room.members.find((m) => m.userId === room.hostId);
  if (!host || host.isConnected || host.disconnectedAt === null || now - host.disconnectedAt < hostAwayMs) return null;
  const online = room.members.filter((m) => m.isConnected).sort((a, b) => a.joinedAt - b.joinedAt);
  return online[0]?.userId ?? null;
}

async function runChecks({ store, rooms, logger, hostAwayMs }: GameClockDeps): Promise<void> {
  // Room bisa saja baru berubah di antara pengecekan dan aksinya; AppError di sini wajar.
  const ignoreExpected = (roomId: string) => (error: unknown) => {
    if (!(error instanceof AppError)) logger.error({ err: error, roomId }, "game clock action failed");
  };

  try {
    const now = Date.now();
    const list = await store.list();
    await Promise.all(
      list.flatMap((room) => {
        const actions: Promise<unknown>[] = [];
        const newHost = replacementForAwayHost(room, now, hostAwayMs);
        if (newHost) actions.push(rooms.transferHost(room.hostId, newHost).catch(ignoreExpected(room.id)));
        if (isPhaseDue(room, now)) {
          actions.push(rooms.dispatchAction(room.hostId, "tick", undefined).catch(ignoreExpected(room.id)));
        }
        return actions;
      }),
    );
  } catch (error) {
    logger.error({ err: error }, "game clock failed");
  }
}
