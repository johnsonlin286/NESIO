/**
 * Kontrak event Socket.IO antara server dan client.
 *
 * File ini SENGAJA tidak meng-import apa pun, supaya bisa di-copy apa adanya
 * ke project client (Next.js, React, React Native, dll) dan dipakai sebagai:
 *
 *   const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(URL, {...});
 *
 * Semua event client -> server memakai acknowledgement (callback terakhir)
 * dengan format `AckResponse<T>`, jadi client tidak perlu mendengarkan event
 * "xxx-success" / "xxx-failed" terpisah.
 */

// ---------------------------------------------------------------------------
// Error & acknowledgement
// ---------------------------------------------------------------------------

export type CoreErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_LOCKED"
  | "INVALID_PASSWORD"
  | "ALREADY_IN_ROOM"
  | "NOT_IN_ROOM"
  | "NOT_HOST"
  | "MEMBER_NOT_FOUND"
  | "UNKNOWN_ROOM_TYPE"
  | "UNKNOWN_ACTION"
  | "INTERNAL_ERROR";

/** Module boleh menambah kode error sendiri (mis. "GAME_ALREADY_STARTED"). */
export type ErrorCode = CoreErrorCode | (string & {});

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type AckResponse<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };
export type Ack<T> = (response: AckResponse<T>) => void;

// ---------------------------------------------------------------------------
// Data yang dikirim ke client
// ---------------------------------------------------------------------------

export type MemberRole = "host" | "member";

export interface MemberView {
  userId: string;
  name: string;
  avatar: string | null;
  role: MemberRole;
  isConnected: boolean;
  /** Epoch ms. */
  joinedAt: number;
}

export interface RoomView<TState = unknown, TSettings = Record<string, unknown>> {
  id: string;
  /** Jenis room = nama module yang menangani room ini (mis. "chat"). */
  type: string;
  name: string | null;
  hostId: string;
  isPublic: boolean;
  hasPassword: boolean;
  /** Room terkunci tidak menerima member baru (member lama tetap bisa reconnect). */
  locked: boolean;
  maxMembers: number;
  members: MemberView[];
  settings: TSettings;
  /** State milik module, sudah difilter per penerima (rahasia tidak ikut terkirim). */
  state: TState;
  createdAt: number;
  updatedAt: number;
}

/** Ringkasan room untuk listing / halaman invite. */
export interface RoomSummary {
  id: string;
  type: string;
  name: string | null;
  hostName: string | null;
  memberCount: number;
  maxMembers: number;
  isPublic: boolean;
  hasPassword: boolean;
  locked: boolean;
  createdAt: number;
}

export interface SessionInfo {
  userId: string;
  name: string;
  avatar: string | null;
  /**
   * Hanya pada mode auth "guest": simpan token ini (localStorage / AsyncStorage)
   * lalu kirim lagi lewat `auth.sessionToken` agar userId tetap sama
   * walaupun koneksi putus, tab di-refresh, atau app ditutup.
   */
  sessionToken: string | null;
  /** Room tempat user berada saat ini (otomatis dipulihkan setelah reconnect). */
  roomId: string | null;
}

export type LeaveReason = "left" | "kicked" | "timeout";
export type CloseReason = "host-left" | "closed-by-host" | "idle" | "server-shutdown";

// ---------------------------------------------------------------------------
// Payload client -> server
// ---------------------------------------------------------------------------

/** Dikirim lewat `io(URL, { auth })`. */
export interface HandshakeAuth {
  /** JWT (mode auth "jwt"). */
  token?: string;
  /** Token sesi guest dari event `session` sebelumnya. */
  sessionToken?: string;
  /** Nama tampilan (mode guest). */
  name?: string;
  avatar?: string;
}

export interface CreateRoomInput {
  /** Nama module. Default: module pertama yang didaftarkan. */
  type?: string;
  name?: string;
  maxMembers?: number;
  isPublic?: boolean;
  password?: string;
  settings?: Record<string, unknown>;
  /** Override nama/avatar khusus di room ini. */
  displayName?: string;
  avatar?: string;
}

export interface JoinRoomInput {
  roomId: string;
  password?: string;
  displayName?: string;
  avatar?: string;
}

export interface UpdateRoomInput {
  name?: string | null;
  maxMembers?: number;
  isPublic?: boolean;
  /** `null` = hapus password. */
  password?: string | null;
  /** Di-merge dengan settings lama lalu divalidasi oleh module. */
  settings?: Record<string, unknown>;
}

export interface TargetUserInput {
  userId: string;
}

export interface RoomActionInput {
  /** Nama action yang didefinisikan module, mis. "send-message". */
  action: string;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  "session:get": (ack: Ack<SessionInfo>) => void;

  "room:create": (input: CreateRoomInput, ack: Ack<RoomView>) => void;
  "room:join": (input: JoinRoomInput, ack: Ack<RoomView>) => void;
  "room:leave": (ack: Ack<null>) => void;
  /** Ambil state terbaru room saat ini (mis. setelah app kembali dari background). */
  "room:sync": (ack: Ack<RoomView | null>) => void;

  // Khusus host
  "room:kick": (input: TargetUserInput, ack: Ack<null>) => void;
  "room:transfer-host": (input: TargetUserInput, ack: Ack<null>) => void;
  "room:update": (input: UpdateRoomInput, ack: Ack<RoomView>) => void;
  "room:close": (ack: Ack<null>) => void;

  /** Satu pintu untuk semua logic spesifik project (game, chat, dll). */
  "room:action": (input: RoomActionInput, ack: Ack<unknown>) => void;
}

export interface ServerToClientEvents {
  /** Dikirim sekali setiap kali koneksi berhasil. */
  session: (session: SessionInfo) => void;

  /** Snapshot lengkap room. Cukup simpan ini di store client. */
  "room:state": (room: RoomView) => void;

  // Event "notifikasi" (untuk toast/sfx). State-nya sudah ada di room:state.
  "room:member-joined": (event: { roomId: string; member: MemberView }) => void;
  "room:member-left": (event: { roomId: string; userId: string; name: string; reason: LeaveReason }) => void;
  "room:member-presence": (event: { roomId: string; userId: string; isConnected: boolean }) => void;
  "room:host-changed": (event: { roomId: string; hostId: string; previousHostId: string }) => void;
  "room:kicked": (event: { roomId: string }) => void;
  "room:closed": (event: { roomId: string; reason: CloseReason }) => void;

  /** Event custom dari module, mis. { event: "chat:message", data: {...} }. */
  "room:event": (event: { roomId: string; event: string; data: unknown }) => void;

  /**
   * (ABC Words) Ke semua koneksi: daftar room di lobby berubah. Tanpa payload;
   * client cukup mengambil ulang `GET /api/rooms`. Lihat src/project/lobby-store.ts.
   */
  "rooms:changed": () => void;
}
