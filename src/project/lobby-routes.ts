import { Router } from "express";
import type { RoomStore } from "../core/store/room-store.js";
import type { RoomService } from "../core/room-service.js";
import { Errors } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { ROOM_TYPE } from "../modules/abc-words/index.js";
import type { LobbyRoom, RoomSummary } from "../shared/contract.js";
import type { RoomKeyService } from "./keys/service.js";

export interface LobbyRouterDeps {
  /** Lazy, karena RoomService baru ada setelah createRoomServer() selesai. */
  rooms: () => RoomService;
  store: RoomStore;
  /** `null` kalau login aplikasi nonaktif: tidak ada kunci, semua room bisa dimulai. */
  keys: RoomKeyService | null;
  logger: Logger;
}

/**
 * Daftar room untuk lobby aplikasi: ringkasan dari core ditambah `hostNeedsKey`. Room yang belum
 * bisa dimulai ditaruh paling bawah.
 */
export function lobbyRouter({ rooms, store, keys, logger }: LobbyRouterDeps): Router {
  async function describe(summaries: RoomSummary[]): Promise<LobbyRoom[]> {
    const hosts = await Promise.all(summaries.map(async (s) => (await store.get(s.id))?.hostId ?? ""));
    let keyless = new Set<string>();
    try {
      if (keys) keyless = await keys.keylessAmong(hosts);
    } catch (error) {
      // Gagal terbuka: database bermasalah tidak boleh mengosongkan daftar room.
      logger.warn({ err: error }, "room key lookup failed, listing rooms without it");
    }
    return summaries.map((summary, i) => ({ ...summary, hostNeedsKey: !summary.locked && keyless.has(hosts[i]!) }));
  }

  const router = Router();

  router.get("/", async (_req, res) => {
    const list = await describe((await rooms().listPublic()).filter((room) => room.type === ROOM_TYPE));
    // `sort` stabil: urutan terbaru dari core tetap berlaku di dalam tiap kelompok.
    res.json({ ok: true, data: list.sort((a, b) => Number(a.hostNeedsKey) - Number(b.hostNeedsKey)) });
  });

  router.get("/:roomId", async (req, res) => {
    const summary = await rooms().getSummary(req.params.roomId);
    if (!summary || summary.type !== ROOM_TYPE) throw Errors.roomNotFound();
    res.json({ ok: true, data: (await describe([summary]))[0] });
  });

  return router;
}
