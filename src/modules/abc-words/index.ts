import { randomInt } from "node:crypto";
import { z } from "zod";
import { createActionFactory, defineRoomModule, type ModuleContext } from "../../core/module.js";
import type { Room } from "../../core/types.js";
import { cleanText } from "../../lib/text.js";
import { chatSendSchema, pushMessage, type ChatState } from "../chat/index.js";

/**
 * Game ABC Words: semua pemain menunjukkan angka 1–10, jumlahnya menjadi huruf,
 * lalu berlomba memberi jawaban berawalan huruf itu sesuai kategori.
 *
 * Sudah ada: ruang tunggu, konfigurasi game (lewat `room:update`), chat, pilih angka,
 * penentuan huruf, menjawab, voting antar pemain, poin, dan skor akhir.
 *
 * Waktu tiap fase disimpan sebagai `deadline`; src/project/game-clock.ts memanggil
 * aksi `tick` begitu deadline lewat.
 */

export const ROOM_TYPE = "abc-words";
export const MAX_ROUNDS = 10;
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
/** Jatah menolak jawaban per pemain per permainan. */
export const MAX_REJECTIONS = 3;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const settingsSchema = z.object({
  historyLimit: z.number().int().min(0).max(200).default(50),
  category: z.enum(["bebas", "hewan", "lagu", "film", "kota-indonesia", "negara", "custom"]).default("bebas"),
  /** Dipakai kalau `category` = "custom". */
  customCategory: z.string().transform(cleanText).pipe(z.string().max(40)).default(""),
  language: z.enum(["id", "en"]).default("id"),
  maxRounds: z.number().int().min(1).max(MAX_ROUNDS).default(MAX_ROUNDS),
});
export type AbcWordsSettings = z.infer<typeof settingsSchema>;

export interface RevealedPick {
  userId: string;
  name: string;
  value: number;
  /** `true` kalau server yang memilihkan karena pemain tidak memilih. */
  auto: boolean;
}

export interface Reveal {
  picks: RevealedPick[];
  total: number;
  letter: string;
  /** Huruf hasil hitungan kalau sudah pernah keluar, sehingga dilompati. */
  skippedFrom: string | null;
}

export interface Answer {
  userId: string;
  name: string;
  text: string;
  /** Bentuk ternormalisasi untuk membandingkan jawaban; tidak dikirim ke client. */
  key: string;
  at: number;
  /** Suara terbuka: siapa saja yang menolak jawaban ini. */
  rejectedBy: { userId: string; name: string }[];
  /** Hasil voting; `null` sampai fase voting selesai. */
  accepted: boolean | null;
}

export type AnswerResult = { status: "accepted" | "duplicate" | "near-tie" };

export interface AbcWordsState extends ChatState {
  phase: "waiting" | "picking" | "reveal" | "answering" | "voting" | "result" | "finished";
  /** Ronde berjalan, mulai dari 1. `0` selama di ruang tunggu. */
  round: number;
  /** Epoch ms saat fase ini berakhir. `null` kalau fase tidak berbatas waktu. */
  deadline: number | null;
  /** Panjang fase berjalan saat deadline terakhir ditetapkan; dipakai client untuk bar waktu. */
  phaseMs: number | null;
  /** Epoch ms permainan dihentikan kalau pemain online tetap kurang dari minimum. */
  abandonAt: number | null;
  /** Alasan permainan terakhir berakhir; tampil di ruang tunggu. */
  endedReason: string | null;
  /** Rahasia selama fase picking; lihat `serializeState`. */
  picks: Record<string, number>;
  usedLetters: string[];
  reveal: Reveal | null;
  answers: Answer[];
  answeringStartedAt: number | null;
  /** Timer pemain terakhir hanya berlaku sekali per ronde. */
  lastCallUsed: boolean;
  /** Pemain yang sudah memakai keringanan "keduluan" di ronde ini. */
  graceUsedBy: string[];
  /** Skor per pemain dalam satu permainan. */
  scores: Record<string, number>;
  /** Jatah tolak yang sudah terpakai dalam satu permainan. */
  rejectionsUsed: Record<string, number>;
}

export interface AbcWordsTiming {
  pickMs: number;
  revealMs: number;
  /** Jeda sebelum game dihentikan saat pemain online kurang, supaya refresh tidak mematikan game. */
  abandonMs: number;
  answerMs: number;
  /** Waktu untuk pemain terakhir yang belum menjawab. */
  lastPlayerMs: number;
  /** Jawaban sama yang masuk dalam selang ini dianggap "keduluan". */
  nearTieMs: number;
  /** Sisa waktu minimal yang dijamin untuk pemain yang keduluan. */
  graceMs: number;
  /** Jawaban lebih cepat dari ini setelah fase menjawab dimulai ditolak (anti bot). */
  minAnswerMs: number;
  votingMs: number;
  resultMs: number;
  /** Layar skor akhir kembali sendiri ke ruang tunggu setelah selang ini. */
  finishedMs: number;
}

const DEFAULT_TIMING: AbcWordsTiming = {
  pickMs: 10_000,
  revealMs: 4_000,
  abandonMs: 5_000,
  answerMs: 30_000,
  lastPlayerMs: 10_000,
  nearTieMs: 2_000,
  graceMs: 10_000,
  minAnswerMs: 1_000,
  votingMs: 15_000,
  resultMs: 5_000,
  finishedMs: 30_000,
};

const ANSWER_MIN = 2;
const ANSWER_MAX = 40;

type Ctx = ModuleContext<AbcWordsState, AbcWordsSettings>;

const action = createActionFactory<AbcWordsState, AbcWordsSettings>();

/** `(total - 1) % 26`, lalu lompat ke huruf berikutnya kalau sudah pernah keluar. */
export function drawLetter(total: number, used: readonly string[]): { letter: string; skippedFrom: string | null } {
  const start = (total - 1) % ALPHABET.length;
  const computed = ALPHABET[start]!;
  for (let offset = 0; offset < ALPHABET.length; offset++) {
    const letter = ALPHABET[(start + offset) % ALPHABET.length]!;
    if (!used.includes(letter)) return { letter, skippedFrom: offset === 0 ? null : computed };
  }
  throw new Error("Semua huruf sudah terpakai");
}

/** Huruf kecil tanpa aksen, spasi sudah dirapikan oleh `cleanText`. */
export function answerKey(cleaned: string): string {
  return cleaned.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function isValidAnswerKey(key: string): boolean {
  return key.length >= ANSWER_MIN && key.length <= ANSWER_MAX && /^[a-z ]+$/.test(key);
}

type RoundFields = "picks" | "reveal" | "answers" | "answeringStartedAt" | "lastCallUsed" | "graceUsedBy";

function emptyRound(): Pick<AbcWordsState, RoundFields> {
  return { picks: {}, reveal: null, answers: [], answeringStartedAt: null, lastCallUsed: false, graceUsedBy: [] };
}

function idleFields() {
  return {
    phase: "waiting" as const,
    round: 0,
    deadline: null,
    phaseMs: null,
    abandonAt: null,
    usedLetters: [] as string[],
    scores: {} as Record<string, number>,
    rejectionsUsed: {} as Record<string, number>,
    ...emptyRound(),
  };
}

function setDeadline(ctx: Ctx, ms: number): void {
  ctx.room.state.deadline = ctx.now() + ms;
  ctx.room.state.phaseMs = ms;
}

function backToWaiting(ctx: Ctx, text: string): void {
  Object.assign(ctx.room.state, idleFields());
  ctx.room.state.endedReason = text;
  ctx.setLocked(false);
  pushMessage(ctx, { userId: null, name: "system", text });
}

export function createAbcWordsModule(overrides: Partial<AbcWordsTiming> = {}) {
  const timing: AbcWordsTiming = { ...DEFAULT_TIMING, ...overrides };

  function startRound(ctx: Ctx, round: number): void {
    const { state } = ctx.room;
    Object.assign(state, emptyRound());
    state.phase = "picking";
    state.round = round;
    setDeadline(ctx, timing.pickMs);
  }

  function startAnswering(ctx: Ctx): void {
    const { state } = ctx.room;
    state.phase = "answering";
    state.answeringStartedAt = ctx.now();
    setDeadline(ctx, timing.answerMs);
  }

  function finishAnswering(ctx: Ctx): void {
    const { state } = ctx.room;
    if (state.answers.length === 0) {
      showResult(ctx);
      return;
    }
    state.phase = "voting";
    setDeadline(ctx, timing.votingMs);
  }

  /** Jawaban gugur kalau lebih dari separuh pemain lain yang online menolaknya. */
  function showResult(ctx: Ctx): void {
    const { state, members } = ctx.room;
    const online = members.filter((m) => m.isConnected).map((m) => m.userId);

    for (const answer of state.answers) {
      const voters = online.filter((id) => id !== answer.userId);
      const rejections = answer.rejectedBy.filter((r) => voters.includes(r.userId)).length;
      answer.accepted = rejections * 2 <= voters.length;
      if (answer.accepted) state.scores[answer.userId] = (state.scores[answer.userId] ?? 0) + 1;
    }

    state.phase = "result";
    setDeadline(ctx, timing.resultMs);
  }

  function showFinalScores(ctx: Ctx): void {
    ctx.room.state.phase = "finished";
    setDeadline(ctx, timing.finishedMs);
  }

  /** Selesai kalau semua pemain online sudah menjawab; pemain terakhir dapat waktu sendiri. */
  function checkAnswering(ctx: Ctx): void {
    const { state, members } = ctx.room;
    if (state.phase !== "answering") return;
    const waitingFor = members.filter((m) => m.isConnected && !state.answers.some((a) => a.userId === m.userId));
    if (waitingFor.length === 0) {
      finishAnswering(ctx);
    } else if (waitingFor.length === 1 && !state.lastCallUsed) {
      state.lastCallUsed = true;
      setDeadline(ctx, timing.lastPlayerMs);
    }
  }

  function revealLetter(ctx: Ctx): void {
    const { room } = ctx;
    const { state } = room;
    const picks = room.members.map((member): RevealedPick => {
      const chosen = state.picks[member.userId];
      return {
        userId: member.userId,
        name: member.name,
        value: chosen ?? randomInt(1, 11),
        auto: chosen === undefined,
      };
    });
    const total = picks.reduce((sum, pick) => sum + pick.value, 0);
    const { letter, skippedFrom } = drawLetter(total, state.usedLetters);

    state.phase = "reveal";
    setDeadline(ctx, timing.revealMs);
    state.picks = {};
    state.usedLetters.push(letter);
    state.reveal = { picks, total, letter, skippedFrom };
  }

  /** Pemain yang putus tidak ditunggu; server memilihkan angka untuk mereka. */
  function revealIfEveryonePicked(ctx: Ctx): void {
    const { room } = ctx;
    if (room.state.phase !== "picking") return;
    const online = room.members.filter((m) => m.isConnected);
    if (online.length > 0 && online.every((m) => room.state.picks[m.userId] !== undefined)) revealLetter(ctx);
  }

  /**
   * Member yang putus tetap tercatat di room selama masa tunggu reconnect (30 detik),
   * jadi yang dihitung di sini adalah yang benar-benar online.
   */
  function watchOnlinePlayers(ctx: Ctx): void {
    const { state, members } = ctx.room;
    if (state.phase === "waiting" || state.phase === "finished") {
      state.abandonAt = null;
      return;
    }
    if (members.filter((m) => m.isConnected).length >= MIN_PLAYERS) state.abandonAt = null;
    else state.abandonAt ??= ctx.now() + timing.abandonMs;
  }

  return defineRoomModule<AbcWordsState, AbcWordsSettings>({
    type: ROOM_TYPE,
    settingsSchema,
    maxMembers: { min: MIN_PLAYERS, max: MAX_PLAYERS, default: MAX_PLAYERS },

    createState: () => ({ messages: [], endedReason: null, ...idleFields() }),

    // Angka pemain lain tidak pernah dikirim selama fase picking.
    serializeState(state, viewerId) {
      const {
        picks,
        deadline,
        answers,
        abandonAt: _abandonAt,
        answeringStartedAt: _answeringStartedAt,
        lastCallUsed: _lastCallUsed,
        graceUsedBy: _graceUsedBy,
        rejectionsUsed,
        ...visible
      } = state;
      return {
        ...visible,
        answers: answers.map(({ key: _key, ...answer }) => answer),
        // Sisa waktu, bukan jam server, supaya tidak terpengaruh jam perangkat pemain.
        remainingMs: deadline === null ? null : Math.max(deadline - Date.now(), 0),
        pickedBy: Object.keys(picks),
        myPick: viewerId === null ? null : (picks[viewerId] ?? null),
        rejectionsLeft: MAX_REJECTIONS - (viewerId === null ? 0 : (rejectionsUsed[viewerId] ?? 0)),
      };
    },

    onMemberJoin(ctx, member) {
      pushMessage(ctx, { userId: null, name: "system", text: `${member.name} bergabung` });
    },

    onMemberLeave(ctx, member, reason) {
      const text = reason === "kicked" ? `${member.name} dikeluarkan` : `${member.name} keluar`;
      pushMessage(ctx, { userId: null, name: "system", text });

      const { state, members } = ctx.room;
      delete state.picks[member.userId];
      if (state.phase !== "waiting" && state.phase !== "finished" && members.length < MIN_PLAYERS) {
        backToWaiting(ctx, "Permainan berakhir karena pemain tidak cukup");
        return;
      }
      watchOnlinePlayers(ctx);
      revealIfEveryonePicked(ctx);
      checkAnswering(ctx);
    },

    onMemberPresence(ctx) {
      watchOnlinePlayers(ctx);
      revealIfEveryonePicked(ctx);
      checkAnswering(ctx);
    },

    onHostChange(ctx) {
      const newHost = ctx.room.members.find((m) => m.userId === ctx.room.hostId);
      if (newHost) pushMessage(ctx, { userId: null, name: "system", text: `${newHost.name} sekarang menjadi host` });
    },

    onSettingsChange(ctx) {
      if (ctx.room.state.phase !== "waiting") {
        ctx.fail("GAME_RUNNING", "Aturan main tidak bisa diubah saat permainan berjalan");
      }
    },

    actions: {
      start: action({
        hostOnly: true,
        handler(ctx) {
          const { room } = ctx;
          if (room.state.phase !== "waiting") ctx.fail("GAME_ALREADY_STARTED", "Permainan sudah berjalan");
          if (room.members.filter((m) => m.isConnected).length < MIN_PLAYERS) {
            ctx.fail("NOT_ENOUGH_PLAYERS", `Butuh minimal ${MIN_PLAYERS} pemain yang online`);
          }
          if (room.settings.category === "custom" && !room.settings.customCategory) {
            ctx.fail("CATEGORY_REQUIRED", "Tulis nama kategorinya dulu");
          }

          room.state.endedReason = null;
          ctx.setLocked(true); // pemain baru tidak bisa masuk selama permainan
          pushMessage(ctx, { userId: null, name: "system", text: "Permainan dimulai" });
          startRound(ctx, 1);
        },
      }),

      pick: action({
        schema: z.object({ value: z.number().int().min(1).max(10) }),
        handler(ctx, { value }) {
          if (ctx.room.state.phase !== "picking") ctx.fail("WRONG_PHASE", "Waktu memilih angka sudah lewat");
          ctx.room.state.picks[ctx.sender!.userId] = value;
          revealIfEveryonePicked(ctx);
        },
      }),

      answer: action({
        schema: z.object({ text: z.string().max(200) }),
        // Duplikat dikembalikan sebagai hasil, bukan `ctx.fail`, karena `ctx.fail` membatalkan
        // semua perubahan state, termasuk tambahan waktu untuk pemain yang keduluan.
        handler(ctx, { text }): AnswerResult {
          const { state } = ctx.room;
          const sender = ctx.sender!;
          const now = ctx.now();

          if (state.phase !== "answering" || state.deadline === null || now >= state.deadline) {
            return ctx.fail("WRONG_PHASE", "Waktu menjawab sudah habis");
          }
          if (now - state.answeringStartedAt! < timing.minAnswerMs) ctx.fail("TOO_FAST", "Terlalu cepat, coba lagi");
          if (state.answers.some((a) => a.userId === sender.userId))
            ctx.fail("ALREADY_ANSWERED", "Kamu sudah menjawab");

          const cleaned = cleanText(text);
          const key = answerKey(cleaned);
          if (!isValidAnswerKey(key)) {
            ctx.fail("INVALID_ANSWER", `Jawaban harus ${ANSWER_MIN}–${ANSWER_MAX} karakter, hanya huruf dan spasi`);
          }
          const letter = state.reveal!.letter;
          if (key[0]!.toUpperCase() !== letter) ctx.fail("WRONG_LETTER", `Jawaban harus berawalan huruf ${letter}`);

          const existing = state.answers.find((a) => a.key === key);
          if (existing) {
            const nearTie = now - existing.at < timing.nearTieMs && !state.graceUsedBy.includes(sender.userId);
            if (!nearTie) return { status: "duplicate" };
            state.graceUsedBy.push(sender.userId);
            if (state.deadline - now < timing.graceMs) setDeadline(ctx, timing.graceMs);
            return { status: "near-tie" };
          }

          state.answers.push({
            userId: sender.userId,
            name: sender.name,
            text: cleaned,
            key,
            at: now,
            rejectedBy: [],
            accepted: null,
          });
          checkAnswering(ctx);
          return { status: "accepted" };
        },
      }),

      /** Menolak jawaban pemain lain, atau membatalkannya (jatahnya kembali). */
      reject: action({
        schema: z.object({ answerUserId: z.string().min(1).max(128), rejected: z.boolean() }),
        handler(ctx, { answerUserId, rejected }) {
          const { state } = ctx.room;
          const sender = ctx.sender!;

          if (state.phase !== "voting") ctx.fail("WRONG_PHASE", "Waktu voting sudah habis");
          if (answerUserId === sender.userId) ctx.fail("OWN_ANSWER", "Jawaban sendiri tidak bisa ditolak");
          const answer = state.answers.find((a) => a.userId === answerUserId);
          if (!answer) return ctx.fail("ANSWER_NOT_FOUND", "Jawaban tidak ditemukan");

          const index = answer.rejectedBy.findIndex((r) => r.userId === sender.userId);
          if (rejected === index >= 0) return; // sudah sesuai permintaan

          const used = state.rejectionsUsed[sender.userId] ?? 0;
          if (rejected) {
            if (used >= MAX_REJECTIONS) ctx.fail("NO_REJECTIONS_LEFT", "Jatah tolak kamu sudah habis");
            answer.rejectedBy.push({ userId: sender.userId, name: sender.name });
            state.rejectionsUsed[sender.userId] = used + 1;
          } else {
            answer.rejectedBy.splice(index, 1);
            state.rejectionsUsed[sender.userId] = used - 1;
          }
        },
      }),

      /** Maju ke fase berikutnya. Boleh dipanggil siapa saja: tanpa efek sebelum deadline lewat. */
      tick: action({
        handler(ctx) {
          const { state } = ctx.room;
          const now = ctx.now();
          if (state.abandonAt !== null && now >= state.abandonAt) {
            backToWaiting(ctx, "Permainan berakhir karena pemain lain terputus");
            return;
          }
          if (state.deadline === null || now < state.deadline) ctx.fail("NOT_DUE", "Waktu fase ini belum habis");

          if (state.phase === "picking") revealLetter(ctx);
          else if (state.phase === "reveal") startAnswering(ctx);
          else if (state.phase === "answering") finishAnswering(ctx);
          else if (state.phase === "voting") showResult(ctx);
          else if (state.phase === "finished") backToWaiting(ctx, "Permainan selesai");
          else if (state.round >= ctx.room.settings.maxRounds) showFinalScores(ctx);
          else startRound(ctx, state.round + 1);
        },
      }),

      end: action({
        hostOnly: true,
        handler(ctx) {
          if (ctx.room.state.phase === "waiting") ctx.fail("GAME_NOT_STARTED", "Permainan belum dimulai");
          backToWaiting(ctx, ctx.room.state.phase === "finished" ? "Permainan selesai" : "Host mengakhiri permainan");
        },
      }),

      send: action({
        schema: chatSendSchema,
        sync: false,
        handler(ctx, { text }) {
          const message = pushMessage(ctx, { userId: ctx.sender!.userId, name: ctx.sender!.name, text });
          ctx.emit("chat:message", message);
          return message;
        },
      }),
    },
  });
}

export const abcWordsModule = createAbcWordsModule();

/** Dipakai jam game untuk menemukan room yang fasenya sudah habis. */
export function isPhaseDue(room: Room, now: number): boolean {
  if (room.type !== ROOM_TYPE) return false;
  const { deadline, abandonAt } = room.state as AbcWordsState;
  return (deadline !== null && now >= deadline) || (abandonAt !== null && now >= abandonAt);
}
