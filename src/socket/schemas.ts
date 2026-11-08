import { z } from "zod";
import { avatarSchema, displayNameSchema } from "../auth/handshake.js";
import { cleanText } from "../lib/text.js";
import type {
  CreateRoomInput,
  JoinRoomInput,
  RoomActionInput,
  TargetUserInput,
  UpdateRoomInput,
} from "../shared/contract.js";

const roomName = z.string().transform(cleanText).pipe(z.string().min(1).max(50));
const roomPassword = z.string().min(1).max(64);
const maxMembers = z.number().int().positive();

export const createRoomSchema: z.ZodType<CreateRoomInput> = z.object({
  type: z.string().trim().min(1).max(40).optional(),
  name: roomName.optional(),
  maxMembers: maxMembers.optional(),
  isPublic: z.boolean().optional(),
  password: roomPassword.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  displayName: displayNameSchema.optional(),
  avatar: avatarSchema.optional(),
});

export const joinRoomSchema: z.ZodType<JoinRoomInput> = z.object({
  roomId: z.string().trim().min(4).max(12),
  password: roomPassword.optional(),
  displayName: displayNameSchema.optional(),
  avatar: avatarSchema.optional(),
});

export const updateRoomSchema: z.ZodType<UpdateRoomInput> = z.object({
  name: roomName.nullable().optional(),
  maxMembers: maxMembers.optional(),
  isPublic: z.boolean().optional(),
  password: roomPassword.nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const targetUserSchema: z.ZodType<TargetUserInput> = z.object({
  userId: z.string().min(1).max(128),
});

export const roomActionSchema: z.ZodType<RoomActionInput> = z.object({
  action: z.string().min(1).max(64),
  payload: z.unknown().optional(),
});
