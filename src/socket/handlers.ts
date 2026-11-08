import type { z } from "zod";
import type { PresenceTracker } from "../core/presence.js";
import type { RoomService } from "../core/room-service.js";
import { AppError, Errors } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { FixedWindowLimiter } from "../lib/rate-limiter.js";
import { parseOrThrow } from "../lib/validation.js";
import type { AckResponse, ClientToServerEvents, SessionInfo } from "../shared/contract.js";
import {
  createRoomSchema,
  joinRoomSchema,
  roomActionSchema,
  targetUserSchema,
  updateRoomSchema,
} from "./schemas.js";
import type { AppSocket } from "./types.js";

export interface HandlerDeps {
  rooms: RoomService;
  presence: PresenceTracker;
  limiter: FixedWindowLimiter;
  logger: Logger;
}

type AnyAck = (response: AckResponse<unknown>) => void;

/**
 * Daftarkan semua event core room ke satu socket.
 * Setiap handler: rate limit -> validasi -> logic -> balas via ack.
 */
export function registerRoomHandlers(socket: AppSocket, deps: HandlerDeps): void {
  const { rooms, limiter, logger } = deps;
  const { identity } = socket.data;
  const userId = identity.userId;

  function on<TInput>(
    event: keyof ClientToServerEvents,
    schema: z.ZodType<TInput> | null,
    handler: (input: TInput) => Promise<unknown>,
  ): void {
    (socket.on as (event: string, listener: (...args: unknown[]) => void) => void)(event, async (...args) => {
      const ack = typeof args.at(-1) === "function" ? (args.pop() as AnyAck) : null;
      try {
        if (!limiter.tryConsume()) throw Errors.rateLimited();
        if (!ack) throw new AppError("VALIDATION_ERROR", "Event ini wajib memakai acknowledgement callback");
        const input = (schema ? parseOrThrow(schema, args[0] ?? {}) : undefined) as TInput;
        const data = await handler(input);
        ack({ ok: true, data: data ?? null });
      } catch (error) {
        const appError = error instanceof AppError ? error : null;
        if (!appError) logger.error({ err: error, event }, "unhandled socket handler error");
        else logger.debug({ event, code: appError.code }, "socket handler rejected");
        ack?.({ ok: false, error: (appError ?? Errors.internal()).toPayload() });
      }
    });
  }

  on("session:get", null, async (): Promise<SessionInfo> => buildSession(socket, await rooms.findRoomIdByUser(userId)));

  on("room:create", createRoomSchema, (input) => rooms.create(identity, input));
  on("room:join", joinRoomSchema, (input) => rooms.join(identity, input));
  on("room:leave", null, () => rooms.leave(userId));
  on("room:sync", null, () => rooms.getViewForUser(userId));

  on("room:kick", targetUserSchema, (input) => rooms.kick(userId, input.userId));
  on("room:transfer-host", targetUserSchema, (input) => rooms.transferHost(userId, input.userId));
  on("room:update", updateRoomSchema, (input) => rooms.update(userId, input));
  on("room:close", null, () => rooms.close(userId));

  on("room:action", roomActionSchema, (input) => rooms.dispatchAction(userId, input.action, input.payload));
}

export function buildSession(socket: AppSocket, roomId: string | null): SessionInfo {
  const { identity, sessionToken } = socket.data;
  return {
    userId: identity.userId,
    name: identity.name,
    avatar: identity.avatar,
    sessionToken,
    roomId,
  };
}
