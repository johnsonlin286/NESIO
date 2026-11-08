import { Router } from "express";

export function healthRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.json({ status: "ok", uptime: Math.round(process.uptime()) });
  });
  return router;
}
