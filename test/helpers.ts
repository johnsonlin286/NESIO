import { io as connectClient, type Socket } from "socket.io-client";
import { loadConfig } from "../src/config/env.js";
import type { AnyRoomModule } from "../src/core/module.js";
import { createLogger } from "../src/lib/logger.js";
import { modules as defaultModules } from "../src/modules/index.js";
import { createRoomServer, type RoomServer } from "../src/server.js";
import type {
  AckResponse,
  ClientToServerEvents,
  HandshakeAuth,
  ServerToClientEvents,
  SessionInfo,
} from "../src/shared/contract.js";

export type TestClient = Socket<ServerToClientEvents, ClientToServerEvents> & { session: SessionInfo };

const servers: RoomServer[] = [];
const clients: Socket[] = [];

export async function startServer(env: Record<string, string> = {}, modules: AnyRoomModule[] = defaultModules) {
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "silent",
    RECONNECT_GRACE_MS: "300",
    SOCKET_RATE_LIMIT_MAX: "1000",
    ...env,
  });
  const server = createRoomServer({ config, modules, logger: createLogger(config) });
  const port = await server.start();
  servers.push(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

/** Connect dan tunggu event `session` pertama. */
export async function connect(url: string, auth: HandshakeAuth = {}): Promise<TestClient> {
  const socket = connectClient(url, {
    auth,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  }) as TestClient;
  clients.push(socket);

  socket.session = await new Promise<SessionInfo>((resolve, reject) => {
    socket.once("session", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

/** Emit dengan ack; kembalikan response mentah `{ ok, data | error }`. */
export async function call<T = unknown>(socket: Socket, event: string, payload?: unknown): Promise<AckResponse<T>> {
  const timed = socket.timeout(2000) as unknown as {
    emitWithAck(event: string, ...args: unknown[]): Promise<AckResponse<T>>;
  };
  return payload === undefined ? timed.emitWithAck(event) : timed.emitWithAck(event, payload);
}

/** Emit dan pastikan sukses; kembalikan `data`. */
export async function ok<T = unknown>(socket: Socket, event: string, payload?: unknown): Promise<T> {
  const response = await call<T>(socket, event, payload);
  if (!response.ok) throw new Error(`${event} gagal: ${response.error.code} ${response.error.message}`);
  return response.data;
}

export function waitFor<T = unknown>(
  socket: Socket,
  event: string,
  predicate: (data: T) => boolean = () => true,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`timeout menunggu event "${event}"`));
    }, timeoutMs);
    const listener = (data: T) => {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    };
    socket.on(event, listener);
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cleanup(): Promise<void> {
  for (const client of clients.splice(0)) client.disconnect();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
}
