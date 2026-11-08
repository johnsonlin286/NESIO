import type { AppConfig } from "../config/env.js";
import { AppError, Errors } from "../lib/errors.js";
import { generateRoomCode, normalizeRoomCode } from "../lib/ids.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import type { Logger } from "../lib/logger.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { parseOrThrow } from "../lib/validation.js";
import type {
  CloseReason,
  CreateRoomInput,
  JoinRoomInput,
  LeaveReason,
  MemberView,
  RoomSummary,
  RoomView,
  UpdateRoomInput,
} from "../shared/contract.js";
import type { AnyRoomModule, ModuleContext, ModuleRegistry } from "./module.js";
import type { RoomNotifier } from "./notifier.js";
import type { RoomStore } from "./store/room-store.js";
import type { Identity, Member, Room } from "./types.js";

export interface RoomServiceOptions {
  store: RoomStore;
  modules: ModuleRegistry;
  notifier: RoomNotifier;
  logger: Logger;
  config: AppConfig["room"];
  now?: () => number;
}

export interface PresenceResult {
  roomId: string;
  reconnectGraceMs: number;
}

/**
 * Satu "transaksi" perubahan room. Efek samping (emit, join/leave channel)
 * ditampung dulu dan baru dijalankan setelah room tersimpan, sehingga
 * error di tengah jalan tidak meninggalkan state/event setengah jadi.
 */
class RoomTransaction {
  readonly outbox: Array<() => void> = [];
  sync = false;
  deleted = false;

  constructor(readonly room: Room) {}

  after(effect: () => void): void {
    this.outbox.push(effect);
  }
}

const MAX_ROOM_CODE_ATTEMPTS = 20;

export class RoomService {
  private readonly store: RoomStore;
  private readonly modules: ModuleRegistry;
  private readonly notifier: RoomNotifier;
  private readonly logger: Logger;
  private readonly config: AppConfig["room"];
  private readonly now: () => number;
  private readonly mutex = new KeyedMutex();

  constructor(options: RoomServiceOptions) {
    this.store = options.store;
    this.modules = options.modules;
    this.notifier = options.notifier;
    this.logger = options.logger.child({ component: "rooms" });
    this.config = options.config;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  async findRoomIdByUser(userId: string): Promise<string | null> {
    return this.store.findRoomIdByUser(userId);
  }

  async getViewForUser(userId: string): Promise<RoomView | null> {
    const roomId = await this.store.findRoomIdByUser(userId);
    if (!roomId) return null;
    const room = await this.store.get(roomId);
    return room ? this.toView(room, userId) : null;
  }

  async getSummary(roomId: string): Promise<RoomSummary | null> {
    const room = await this.store.get(normalizeRoomCode(roomId));
    return room ? this.toSummary(room) : null;
  }

  async listPublic(): Promise<RoomSummary[]> {
    const rooms = await this.store.list();
    return rooms
      .filter((room) => room.isPublic)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => this.toSummary(room));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async create(identity: Identity, input: CreateRoomInput): Promise<RoomView> {
    return this.mutex.run(`user:${identity.userId}`, async () => {
      const existingRoomId = await this.store.findRoomIdByUser(identity.userId);
      if (existingRoomId) throw Errors.alreadyInRoom(existingRoomId);

      const type = input.type ?? this.modules.defaultModuleType;
      const module = this.modules.get(type);
      if (!module) throw Errors.unknownRoomType(type);

      const settings = this.parseSettings(module, input.settings ?? {});
      const maxMembers = this.resolveMaxMembers(module, input.maxMembers);
      const roomId = await this.generateUniqueRoomId();
      const now = this.now();
      const host = this.createMember(identity, input, "host", now);

      const room: Room = {
        id: roomId,
        type,
        name: input.name ?? null,
        hostId: identity.userId,
        isPublic: input.isPublic ?? false,
        passwordHash: input.password ? await hashPassword(input.password) : null,
        locked: false,
        maxMembers,
        members: [host],
        settings,
        state: module.createState({ settings, hostId: identity.userId }),
        createdAt: now,
        updatedAt: now,
      };

      return this.transaction(roomId, async () => room, async (tx) => {
        await module.onMemberJoin?.(this.context(tx, module, host), host);
        tx.after(() => this.notifier.attachUser(identity.userId, roomId));
        tx.sync = true;
        this.logger.info({ roomId, type, userId: identity.userId }, "room created");
        return this.toView(tx.room, identity.userId);
      });
    });
  }

  async join(identity: Identity, input: JoinRoomInput): Promise<RoomView> {
    const roomId = normalizeRoomCode(input.roomId);

    return this.mutex.run(`user:${identity.userId}`, async () => {
      const currentRoomId = await this.store.findRoomIdByUser(identity.userId);
      if (currentRoomId && currentRoomId !== roomId) throw Errors.alreadyInRoom(currentRoomId);

      return this.mutate(roomId, async (tx, module) => {
        const { room } = tx;

        // Sudah member (tab kedua / klik join dua kali): cukup sambungkan lagi.
        const existing = room.members.find((m) => m.userId === identity.userId);
        if (existing) {
          tx.after(() => this.notifier.attachUser(identity.userId, roomId));
          return this.toView(room, identity.userId);
        }

        if (room.locked) throw Errors.roomLocked();
        if (room.members.length >= room.maxMembers) throw Errors.roomFull();
        if (room.passwordHash && !(input.password && (await verifyPassword(input.password, room.passwordHash)))) {
          throw Errors.invalidPassword();
        }

        await module.canJoin?.(this.context(tx, module, null), identity);

        const member = this.createMember(identity, input, "member", this.now());
        room.members.push(member);
        await module.onMemberJoin?.(this.context(tx, module, member), member);

        tx.after(() => this.notifier.toRoom(roomId, "room:member-joined", { roomId, member: toMemberView(member) }));
        tx.after(() => this.notifier.attachUser(identity.userId, roomId));
        tx.sync = true;
        this.logger.info({ roomId, userId: identity.userId }, "member joined");
        return this.toView(room, identity.userId);
      });
    });
  }

  async leave(userId: string): Promise<void> {
    const roomId = await this.requireRoomIdForUser(userId);
    await this.mutate(roomId, async (tx, module) => {
      const member = this.requireMember(tx.room, userId, Errors.notInRoom);
      await this.removeMember(tx, module, member, "left");
    });
  }

  /** Dipanggil saat masa tunggu reconnect habis. Aman dipanggil berkali-kali. */
  async expireDisconnected(userId: string): Promise<void> {
    const roomId = await this.store.findRoomIdByUser(userId);
    if (!roomId) return;
    await this.mutate(roomId, async (tx, module) => {
      const member = tx.room.members.find((m) => m.userId === userId);
      if (!member || member.isConnected) return;
      await this.removeMember(tx, module, member, "timeout");
    }).catch((error: unknown) => this.ignoreRoomNotFound(error));
  }

  async kick(actorId: string, targetId: string): Promise<void> {
    const roomId = await this.requireRoomIdForUser(actorId);
    await this.mutate(roomId, async (tx, module) => {
      this.requireHost(tx.room, actorId);
      if (targetId === actorId) throw new AppError("VALIDATION_ERROR", "Tidak bisa kick diri sendiri");
      const target = this.requireMember(tx.room, targetId, Errors.memberNotFound);
      await this.removeMember(tx, module, target, "kicked");
    });
  }

  async transferHost(actorId: string, targetId: string): Promise<void> {
    const roomId = await this.requireRoomIdForUser(actorId);
    await this.mutate(roomId, async (tx, module) => {
      this.requireHost(tx.room, actorId);
      if (targetId === actorId) return;
      const target = this.requireMember(tx.room, targetId, Errors.memberNotFound);
      await this.changeHost(tx, module, target);
      tx.sync = true;
    });
  }

  async update(actorId: string, input: UpdateRoomInput): Promise<RoomView> {
    const roomId = await this.requireRoomIdForUser(actorId);
    return this.mutate(roomId, async (tx, module) => {
      const { room } = tx;
      this.requireHost(room, actorId);

      if (input.name !== undefined) room.name = input.name;
      if (input.isPublic !== undefined) room.isPublic = input.isPublic;
      if (input.maxMembers !== undefined) {
        const maxMembers = this.resolveMaxMembers(module, input.maxMembers);
        if (maxMembers < room.members.length) {
          throw new AppError("VALIDATION_ERROR", "maxMembers lebih kecil dari jumlah member saat ini");
        }
        room.maxMembers = maxMembers;
      }
      if (input.password !== undefined) {
        room.passwordHash = input.password ? await hashPassword(input.password) : null;
      }
      if (input.settings !== undefined) {
        const previous = room.settings;
        room.settings = this.parseSettings(module, { ...previous, ...input.settings });
        await module.onSettingsChange?.(this.context(tx, module, this.findMember(room, actorId)), previous);
      }

      tx.sync = true;
      return this.toView(room, actorId);
    });
  }

  async close(actorId: string): Promise<void> {
    const roomId = await this.requireRoomIdForUser(actorId);
    await this.mutate(roomId, async (tx) => {
      this.requireHost(tx.room, actorId);
      this.closeRoom(tx, "closed-by-host");
    });
  }

  async dispatchAction(userId: string, action: string, rawPayload: unknown): Promise<unknown> {
    const roomId = await this.requireRoomIdForUser(userId);
    return this.mutate(roomId, async (tx, module) => {
      const sender = this.requireMember(tx.room, userId, Errors.notInRoom);
      const definition = module.actions?.[action];
      if (!definition) throw Errors.unknownAction(action);
      if (definition.hostOnly) this.requireHost(tx.room, userId);

      const payload = definition.schema ? parseOrThrow(definition.schema, rawPayload) : undefined;
      const result = await definition.handler(this.context(tx, module, sender), payload);
      if (definition.sync !== false) tx.sync = true;
      return result ?? null;
    });
  }

  /**
   * Sinkronkan status online/offline member. `isOnline` dievaluasi di dalam lock
   * supaya urutan event connect/disconnect yang balapan tetap menghasilkan status benar.
   * Mengembalikan info room jika user ada di room.
   */
  async syncPresence(userId: string, isOnline: () => boolean): Promise<PresenceResult | null> {
    const roomId = await this.store.findRoomIdByUser(userId);
    if (!roomId) return null;

    return this.mutate(roomId, async (tx, module) => {
      const member = tx.room.members.find((m) => m.userId === userId);
      if (!member) return null;
      const isConnected = isOnline();
      const result = { roomId, reconnectGraceMs: module.reconnectGraceMs ?? this.config.reconnectGraceMs };
      if (member.isConnected === isConnected) return result;

      member.isConnected = isConnected;
      member.disconnectedAt = isConnected ? null : this.now();
      await module.onMemberPresence?.(this.context(tx, module, null), member);
      tx.after(() => this.notifier.toRoom(roomId, "room:member-presence", { roomId, userId, isConnected }));
      tx.sync = true;
      return result;
    }).catch((error: unknown) => {
      this.ignoreRoomNotFound(error);
      return null;
    });
  }

  /** Tutup room yang tidak ada aktivitas melewati ROOM_IDLE_TTL_MS. */
  async sweepIdleRooms(): Promise<number> {
    const threshold = this.now() - this.config.idleTtlMs;
    let closed = 0;
    for (const room of await this.store.list()) {
      if (room.updatedAt >= threshold) continue;
      await this.mutate(room.id, async (tx) => {
        if (tx.room.updatedAt >= threshold) return;
        this.closeRoom(tx, "idle");
        closed++;
      }).catch((error: unknown) => this.ignoreRoomNotFound(error));
    }
    if (closed > 0) this.logger.info({ closed }, "idle rooms closed");
    return closed;
  }

  async closeAll(reason: CloseReason): Promise<void> {
    for (const room of await this.store.list()) {
      await this.mutate(room.id, async (tx) => this.closeRoom(tx, reason)).catch((error: unknown) =>
        this.ignoreRoomNotFound(error),
      );
    }
  }

  // -------------------------------------------------------------------------
  // View
  // -------------------------------------------------------------------------

  toView(room: Room, viewerId: string | null): RoomView {
    const module = this.modules.get(room.type);
    return {
      id: room.id,
      type: room.type,
      name: room.name,
      hostId: room.hostId,
      isPublic: room.isPublic,
      hasPassword: room.passwordHash !== null,
      locked: room.locked,
      maxMembers: room.maxMembers,
      members: room.members.map(toMemberView),
      settings: room.settings,
      state: module?.serializeState ? module.serializeState(room.state, viewerId, room) : room.state,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  toSummary(room: Room): RoomSummary {
    return {
      id: room.id,
      type: room.type,
      name: room.name,
      hostName: room.members.find((m) => m.userId === room.hostId)?.name ?? null,
      memberCount: room.members.length,
      maxMembers: room.maxMembers,
      isPublic: room.isPublic,
      hasPassword: room.passwordHash !== null,
      locked: room.locked,
      createdAt: room.createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async mutate<T>(
    roomId: string,
    fn: (tx: RoomTransaction, module: AnyRoomModule) => Promise<T>,
  ): Promise<T> {
    return this.transaction(
      roomId,
      async () => {
        const room = await this.store.get(roomId);
        if (!room) throw Errors.roomNotFound();
        return room;
      },
      fn,
    );
  }

  private async transaction<T>(
    roomId: string,
    load: () => Promise<Room>,
    fn: (tx: RoomTransaction, module: AnyRoomModule) => Promise<T>,
  ): Promise<T> {
    return this.mutex.run(`room:${roomId}`, async () => {
      const room = await load();
      const module = this.modules.get(room.type);
      if (!module) throw Errors.unknownRoomType(room.type);

      const tx = new RoomTransaction(room);
      const result = await fn(tx, module);

      if (tx.deleted) {
        await this.store.delete(roomId);
      } else {
        room.updatedAt = this.now();
        await this.store.save(room);
      }

      for (const effect of tx.outbox) this.safely(effect);
      if (tx.sync && !tx.deleted) this.broadcastState(room);
      return result;
    });
  }

  private broadcastState(room: Room): void {
    for (const member of room.members) {
      this.safely(() => this.notifier.toUser(member.userId, "room:state", this.toView(room, member.userId)));
    }
  }

  private async removeMember(
    tx: RoomTransaction,
    module: AnyRoomModule,
    member: Member,
    reason: LeaveReason,
  ): Promise<void> {
    const { room } = tx;
    room.members = room.members.filter((m) => m.userId !== member.userId);

    tx.after(() => this.notifier.detachUser(member.userId, room.id));
    if (reason === "kicked") tx.after(() => this.notifier.toUser(member.userId, "room:kicked", { roomId: room.id }));
    this.logger.info({ roomId: room.id, userId: member.userId, reason }, "member left");

    if (room.members.length === 0) {
      tx.deleted = true;
      this.logger.info({ roomId: room.id }, "room deleted (empty)");
      return;
    }

    await module.onMemberLeave?.(this.context(tx, module, null), member, reason);
    tx.after(() =>
      this.notifier.toRoom(room.id, "room:member-left", {
        roomId: room.id,
        userId: member.userId,
        name: member.name,
        reason,
      }),
    );

    if (member.userId === room.hostId) {
      const policy = module.hostLeavePolicy ?? this.config.hostLeavePolicy;
      if (policy === "close") {
        this.closeRoom(tx, "host-left");
        return;
      }
      await this.changeHost(tx, module, pickNextHost(room.members));
    }
    tx.sync = true;
  }

  private async changeHost(tx: RoomTransaction, module: AnyRoomModule, newHost: Member): Promise<void> {
    const { room } = tx;
    const previousHostId = room.hostId;
    for (const member of room.members) member.role = member.userId === newHost.userId ? "host" : "member";
    room.hostId = newHost.userId;

    await module.onHostChange?.(this.context(tx, module, null), previousHostId);
    tx.after(() =>
      this.notifier.toRoom(room.id, "room:host-changed", { roomId: room.id, hostId: newHost.userId, previousHostId }),
    );
  }

  private closeRoom(tx: RoomTransaction, reason: CloseReason): void {
    const { room } = tx;
    const members = [...room.members];
    tx.after(() => this.notifier.toRoom(room.id, "room:closed", { roomId: room.id, reason }));
    for (const member of members) tx.after(() => this.notifier.detachUser(member.userId, room.id));
    tx.deleted = true;
    this.logger.info({ roomId: room.id, reason }, "room closed");
  }

  private context(tx: RoomTransaction, module: AnyRoomModule, sender: Member | null): ModuleContext<unknown, unknown> {
    const { room } = tx;
    return {
      room,
      sender,
      logger: this.logger.child({ roomId: room.id, module: module.type }),
      now: this.now,
      emit: (event, data = null) => {
        tx.after(() => this.notifier.toRoom(room.id, "room:event", { roomId: room.id, event, data }));
      },
      emitTo: (userId, event, data = null) => {
        tx.after(() => this.notifier.toUser(userId, "room:event", { roomId: room.id, event, data }));
      },
      setLocked: (locked) => {
        room.locked = locked;
      },
      fail: (code, message, details) => {
        throw new AppError(code, message, details);
      },
    };
  }

  private createMember(
    identity: Identity,
    input: { displayName?: string; avatar?: string },
    role: Member["role"],
    now: number,
  ): Member {
    return {
      userId: identity.userId,
      name: input.displayName ?? identity.name,
      avatar: input.avatar ?? identity.avatar,
      role,
      isConnected: true,
      joinedAt: now,
      disconnectedAt: null,
    };
  }

  private parseSettings(module: AnyRoomModule, settings: Record<string, unknown>): Record<string, unknown> {
    return module.settingsSchema ? (parseOrThrow(module.settingsSchema, settings) as Record<string, unknown>) : {};
  }

  private resolveMaxMembers(module: AnyRoomModule, requested: number | undefined): number {
    const limit = this.config.maxMembersLimit;
    const min = Math.max(1, module.maxMembers?.min ?? 1);
    const max = Math.min(limit, module.maxMembers?.max ?? limit);
    const value = requested ?? module.maxMembers?.default ?? this.config.defaultMaxMembers;
    if (value < min || value > max) {
      throw new AppError("VALIDATION_ERROR", `maxMembers harus di antara ${min} dan ${max}`);
    }
    return value;
  }

  private async generateUniqueRoomId(): Promise<string> {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt++) {
      const id = generateRoomCode();
      if (!(await this.store.has(id))) return id;
    }
    throw Errors.internal();
  }

  private async requireRoomIdForUser(userId: string): Promise<string> {
    const roomId = await this.store.findRoomIdByUser(userId);
    if (!roomId) throw Errors.notInRoom();
    return roomId;
  }

  private findMember(room: Room, userId: string): Member | null {
    return room.members.find((m) => m.userId === userId) ?? null;
  }

  private requireMember(room: Room, userId: string, error: () => AppError): Member {
    const member = this.findMember(room, userId);
    if (!member) throw error();
    return member;
  }

  private requireHost(room: Room, userId: string): void {
    if (room.hostId !== userId) throw Errors.notHost();
  }

  private ignoreRoomNotFound(error: unknown): void {
    if (error instanceof AppError && error.code === "ROOM_NOT_FOUND") return;
    throw error;
  }

  private safely(effect: () => void): void {
    try {
      effect();
    } catch (error) {
      this.logger.error({ err: error }, "failed to run room side effect");
    }
  }
}

function toMemberView(member: Member): MemberView {
  return {
    userId: member.userId,
    name: member.name,
    avatar: member.avatar,
    role: member.role,
    isConnected: member.isConnected,
    joinedAt: member.joinedAt,
  };
}

/** Host baru: member online yang paling lama di room; kalau semua offline, yang paling lama. */
function pickNextHost(members: Member[]): Member {
  const sorted = [...members].sort((a, b) => a.joinedAt - b.joinedAt);
  return (sorted.find((m) => m.isConnected) ?? sorted[0])!;
}
