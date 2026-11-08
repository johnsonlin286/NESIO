import type { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { ErrorCode, LeaveReason } from "../shared/contract.js";
import type { Identity, Member, Room } from "./types.js";

/**
 * Context yang diterima setiap hook/action module.
 *
 * - Ubah `ctx.room.state` secara langsung; perubahan disimpan otomatis
 *   setelah handler selesai tanpa error.
 * - Jika handler melempar error, SEMUA perubahan dibatalkan dan event
 *   dari `emit`/`emitTo` tidak dikirim.
 */
export interface ModuleContext<TState, TSettings> {
  readonly room: Room<TState, TSettings>;
  /** Member yang memicu aksi ini (`null` untuk aksi sistem, mis. timeout). */
  readonly sender: Member | null;
  readonly logger: Logger;
  now(): number;
  /** Kirim event `room:event` ke semua member room. */
  emit(event: string, data?: unknown): void;
  /** Kirim event `room:event` hanya ke satu user (mis. kartu rahasia). */
  emitTo(userId: string, event: string, data?: unknown): void;
  /** Kunci room supaya tidak ada member baru (mis. saat game berjalan). */
  setLocked(locked: boolean): void;
  /** Batalkan aksi dan kirim error ke client. */
  fail(code: ErrorCode, message: string, details?: unknown): never;
}

export interface ActionDefinition<TState, TSettings, TPayload, TResult = unknown> {
  /** Validasi payload. Tanpa schema, payload diterima sebagai `undefined`. */
  schema?: z.ZodType<TPayload>;
  /** Hanya host yang boleh memanggil action ini. */
  hostOnly?: boolean;
  /**
   * Kirim `room:state` terbaru ke semua member setelah action sukses.
   * Default `true`. Set `false` untuk action yang sangat sering dan
   * cukup memakai `ctx.emit` (mis. posisi kursor).
   */
  sync?: boolean;
  handler(ctx: ModuleContext<TState, TSettings>, payload: TPayload): TResult | Promise<TResult>;
}

export interface RoomModule<TState, TSettings> {
  /** Nama unik; dipakai client sebagai `type` saat membuat room. */
  type: string;

  /** Validasi + default settings room (bisa diubah host lewat `room:update`). */
  settingsSchema?: z.ZodType<TSettings>;

  /** Batas jumlah member khusus module ini (tetap dibatasi ROOM_MAX_MEMBERS_LIMIT). */
  maxMembers?: { min?: number; max?: number; default?: number };

  /** Override HOST_LEAVE_POLICY global. */
  hostLeavePolicy?: "migrate" | "close";

  /** Override RECONNECT_GRACE_MS global. */
  reconnectGraceMs?: number;

  /** State awal saat room dibuat. */
  createState(input: { settings: TSettings; hostId: string }): TState;

  /** Lempar error (`ctx.fail`) untuk menolak user join. */
  canJoin?(ctx: ModuleContext<TState, TSettings>, identity: Identity): void | Promise<void>;
  onMemberJoin?(ctx: ModuleContext<TState, TSettings>, member: Member): void | Promise<void>;
  onMemberLeave?(ctx: ModuleContext<TState, TSettings>, member: Member, reason: LeaveReason): void | Promise<void>;
  onMemberPresence?(ctx: ModuleContext<TState, TSettings>, member: Member): void | Promise<void>;
  onHostChange?(ctx: ModuleContext<TState, TSettings>, previousHostId: string): void | Promise<void>;
  onSettingsChange?(ctx: ModuleContext<TState, TSettings>, previous: TSettings): void | Promise<void>;

  /**
   * Ubah state menjadi data yang boleh dilihat `viewerId`.
   * Wajib untuk game dengan informasi rahasia (role, kartu, jawaban).
   * `viewerId` = null untuk data publik.
   * Default: state dikirim apa adanya.
   */
  serializeState?(state: TState, viewerId: string | null, room: Room<TState, TSettings>): unknown;

  actions?: Record<string, ActionDefinition<TState, TSettings, any, any>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoomModule = RoomModule<any, any>;

/** Helper agar TypeScript bisa meng-infer tipe state & settings. */
export function defineRoomModule<TState, TSettings = Record<string, never>>(
  module: RoomModule<TState, TSettings>,
): RoomModule<TState, TSettings> {
  return module;
}

/**
 * Helper untuk mendefinisikan action dengan payload yang ter-infer dari schema:
 *
 *   const action = createActionFactory<MyState, MySettings>();
 *   actions: { "do-it": action({ schema: z.object({...}), handler: (ctx, payload) => {...} }) }
 */
export function createActionFactory<TState, TSettings = Record<string, never>>() {
  return <TPayload = undefined, TResult = unknown>(
    definition: ActionDefinition<TState, TSettings, TPayload, TResult>,
  ): ActionDefinition<TState, TSettings, TPayload, TResult> => definition;
}

export class ModuleRegistry {
  private readonly modules = new Map<string, AnyRoomModule>();
  private defaultType: string | null = null;

  constructor(modules: AnyRoomModule[]) {
    if (modules.length === 0) throw new Error("Minimal satu room module harus didaftarkan");
    for (const module of modules) {
      if (this.modules.has(module.type)) throw new Error(`Room module "${module.type}" terdaftar dua kali`);
      this.modules.set(module.type, module);
      this.defaultType ??= module.type;
    }
  }

  get(type: string): AnyRoomModule | undefined {
    return this.modules.get(type);
  }

  get defaultModuleType(): string {
    return this.defaultType!;
  }

  get types(): string[] {
    return [...this.modules.keys()];
  }
}
