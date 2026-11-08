import type { RoomNotifier } from "../core/notifier.js";
import { roomChannel, userChannel, type AppServer } from "./types.js";

export class SocketNotifier implements RoomNotifier {
  constructor(private readonly io: AppServer) {}

  toRoom: RoomNotifier["toRoom"] = (roomId, event, ...args) => {
    // Generic event + spread args tidak bisa di-narrow oleh TypeScript; kontraknya dijaga oleh RoomNotifier.
    (this.io.to(roomChannel(roomId)).emit as (event: string, ...args: unknown[]) => boolean)(event, ...args);
  };

  toUser: RoomNotifier["toUser"] = (userId, event, ...args) => {
    (this.io.to(userChannel(userId)).emit as (event: string, ...args: unknown[]) => boolean)(event, ...args);
  };

  attachUser(userId: string, roomId: string): void {
    this.io.in(userChannel(userId)).socketsJoin(roomChannel(roomId));
  }

  detachUser(userId: string, roomId: string): void {
    this.io.in(userChannel(userId)).socketsLeave(roomChannel(roomId));
  }
}
