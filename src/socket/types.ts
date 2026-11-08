import type { Server, Socket } from "socket.io";
import type { Identity } from "../core/types.js";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/contract.js";

export interface SocketData {
  identity: Identity;
  sessionToken: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type InterServerEvents = {};

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export const userChannel = (userId: string) => `user:${userId}`;
export const roomChannel = (roomId: string) => `room:${roomId}`;
