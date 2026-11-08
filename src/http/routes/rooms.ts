import { Router } from "express";
import type { RoomService } from "../../core/room-service.js";
import { Errors } from "../../lib/errors.js";

/**
 * Endpoint read-only untuk halaman lobby / invite.
 * Semua aksi yang mengubah room dilakukan lewat Socket.IO.
 */
export function roomsRouter(rooms: RoomService): Router {
  const router = Router();

  /** Daftar room publik. */
  router.get("/", async (_req, res) => {
    res.json({ ok: true, data: await rooms.listPublic() });
  });

  /** Ringkasan satu room (untuk halaman /join/:roomId). */
  router.get("/:roomId", async (req, res) => {
    const summary = await rooms.getSummary(req.params.roomId);
    if (!summary) throw Errors.roomNotFound();
    res.json({ ok: true, data: summary });
  });

  return router;
}
