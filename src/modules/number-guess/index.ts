import { randomInt } from "node:crypto";
import { z } from "zod";
import { createActionFactory, defineRoomModule, type ModuleContext } from "../../core/module.js";

/**
 * Contoh module game: tebak angka.
 * Menunjukkan pola yang biasa dibutuhkan game multiplayer:
 *   - aksi khusus host (start / reset)
 *   - mengunci room selama game berjalan
 *   - state rahasia yang disembunyikan per penerima (`serializeState`)
 *   - menangani player keluar di tengah game
 *   - error code khusus game
 */

type Phase = "lobby" | "playing" | "finished";
type Hint = "higher" | "lower" | "correct";

interface Guess {
  userId: string;
  name: string;
  value: number;
  hint: Hint;
  at: number;
}

export interface NumberGuessState {
  phase: Phase;
  round: number;
  secret: number | null;
  guesses: Guess[];
  winnerId: string | null;
}

const settingsSchema = z
  .object({
    min: z.number().int().default(1),
    max: z.number().int().default(100),
  })
  .refine((s) => s.max > s.min, { message: "max harus lebih besar dari min", path: ["max"] });
export type NumberGuessSettings = z.infer<typeof settingsSchema>;

const MIN_PLAYERS = 2;

type Ctx = ModuleContext<NumberGuessState, NumberGuessSettings>;
const action = createActionFactory<NumberGuessState, NumberGuessSettings>();

function finish(ctx: Ctx, winnerId: string | null): void {
  const { state } = ctx.room;
  state.phase = "finished";
  state.winnerId = winnerId;
  ctx.setLocked(false);
  ctx.emit("game:finished", { winnerId, secret: state.secret });
}

export const numberGuessModule = defineRoomModule<NumberGuessState, NumberGuessSettings>({
  type: "number-guess",
  settingsSchema,
  maxMembers: { min: MIN_PLAYERS, max: 10, default: 6 },
  // Game ini lebih nyaman kalau host pindah daripada room bubar.
  hostLeavePolicy: "migrate",

  createState: () => ({ phase: "lobby", round: 0, secret: null, guesses: [], winnerId: null }),

  // Angka rahasia hanya terlihat setelah game selesai.
  serializeState: (state) => ({
    ...state,
    secret: state.phase === "finished" ? state.secret : null,
  }),

  onMemberLeave(ctx) {
    if (ctx.room.state.phase === "playing" && ctx.room.members.length < MIN_PLAYERS) {
      finish(ctx, null);
    }
  },

  actions: {
    start: action({
      hostOnly: true,
      handler(ctx) {
        const { room } = ctx;
        if (room.state.phase === "playing") ctx.fail("GAME_ALREADY_STARTED", "Game sudah berjalan");
        if (room.members.length < MIN_PLAYERS) {
          ctx.fail("NOT_ENOUGH_PLAYERS", `Minimal ${MIN_PLAYERS} pemain untuk mulai`);
        }

        room.state = {
          phase: "playing",
          round: room.state.round + 1,
          secret: randomInt(room.settings.min, room.settings.max + 1),
          guesses: [],
          winnerId: null,
        };
        ctx.setLocked(true);
        ctx.emit("game:started", { round: room.state.round });
      },
    }),

    guess: action({
      schema: z.object({ value: z.number().int() }),
      handler(ctx, { value }) {
        const { room } = ctx;
        const sender = ctx.sender!;
        if (room.state.phase !== "playing" || room.state.secret === null) {
          return ctx.fail("GAME_NOT_STARTED", "Game belum dimulai");
        }
        const { min, max } = room.settings;
        if (value < min || value > max) ctx.fail("VALIDATION_ERROR", `Tebakan harus di antara ${min} dan ${max}`);

        const secret = room.state.secret;
        const hint: Hint = value === secret ? "correct" : value < secret ? "higher" : "lower";
        room.state.guesses.push({ userId: sender.userId, name: sender.name, value, hint, at: ctx.now() });

        if (hint === "correct") finish(ctx, sender.userId);
        return { hint };
      },
    }),

    reset: action({
      hostOnly: true,
      handler(ctx) {
        ctx.room.state = { ...ctx.room.state, phase: "lobby", secret: null, guesses: [], winnerId: null };
        ctx.setLocked(false);
      },
    }),
  },
});
