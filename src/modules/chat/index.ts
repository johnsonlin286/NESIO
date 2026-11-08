import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createActionFactory, defineRoomModule, type ModuleContext } from "../../core/module.js";
import { cleanText } from "../../lib/text.js";

/**
 * Contoh module paling sederhana: chat room.
 *
 * Client:
 *   socket.emit("room:create", { type: "chat" }, ack)
 *   socket.emit("room:action", { action: "send", payload: { text: "halo" } }, ack)
 *   socket.on("room:event", ({ event, data }) => { if (event === "chat:message") ... })
 */

export interface ChatMessage {
  id: string;
  userId: string | null; // null = pesan sistem
  name: string;
  text: string;
  at: number;
}

export interface ChatState {
  messages: ChatMessage[];
}

const settingsSchema = z.object({
  historyLimit: z.number().int().min(0).max(200).default(50),
});
export type ChatSettings = z.infer<typeof settingsSchema>;

type Ctx = ModuleContext<ChatState, ChatSettings>;
const action = createActionFactory<ChatState, ChatSettings>();

function pushMessage(ctx: Ctx, message: Omit<ChatMessage, "id" | "at">): ChatMessage {
  const full: ChatMessage = { id: randomUUID(), at: ctx.now(), ...message };
  const { messages } = ctx.room.state;
  messages.push(full);
  const limit = ctx.room.settings.historyLimit;
  if (messages.length > limit) messages.splice(0, messages.length - limit);
  return full;
}

export const chatModule = defineRoomModule<ChatState, ChatSettings>({
  type: "chat",
  settingsSchema,
  maxMembers: { min: 2, max: 50, default: 20 },

  createState: () => ({ messages: [] }),

  onMemberJoin(ctx, member) {
    pushMessage(ctx, { userId: null, name: "system", text: `${member.name} bergabung` });
  },

  onMemberLeave(ctx, member, reason) {
    const text = reason === "kicked" ? `${member.name} dikeluarkan` : `${member.name} keluar`;
    pushMessage(ctx, { userId: null, name: "system", text });
  },

  actions: {
    send: action({
      schema: z.object({
        text: z.string().transform(cleanText).pipe(z.string().min(1).max(500)),
      }),
      // Pesan dikirim lewat event; tidak perlu broadcast seluruh room:state setiap pesan.
      sync: false,
      handler(ctx, { text }) {
        const message = pushMessage(ctx, { userId: ctx.sender!.userId, name: ctx.sender!.name, text });
        ctx.emit("chat:message", message);
        return message;
      },
    }),

    typing: action({
      schema: z.object({ isTyping: z.boolean() }),
      sync: false,
      handler(ctx, { isTyping }) {
        ctx.emit("chat:typing", { userId: ctx.sender!.userId, isTyping });
      },
    }),
  },
});
