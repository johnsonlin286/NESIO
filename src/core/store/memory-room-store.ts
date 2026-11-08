import type { Room } from "../types.js";
import type { RoomStore } from "./room-store.js";

export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly userIndex = new Map<string, string>();

  async get(roomId: string): Promise<Room | null> {
    const room = this.rooms.get(roomId);
    return room ? structuredClone(room) : null;
  }

  async has(roomId: string): Promise<boolean> {
    return this.rooms.has(roomId);
  }

  async save(room: Room): Promise<void> {
    const previous = this.rooms.get(room.id);
    if (previous) {
      for (const member of previous.members) {
        if (this.userIndex.get(member.userId) === room.id) this.userIndex.delete(member.userId);
      }
    }
    const copy = structuredClone(room);
    this.rooms.set(room.id, copy);
    for (const member of copy.members) this.userIndex.set(member.userId, room.id);
  }

  async delete(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const member of room.members) {
      if (this.userIndex.get(member.userId) === roomId) this.userIndex.delete(member.userId);
    }
    this.rooms.delete(roomId);
  }

  async list(): Promise<Room[]> {
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }

  async findRoomIdByUser(userId: string): Promise<string | null> {
    return this.userIndex.get(userId) ?? null;
  }
}
