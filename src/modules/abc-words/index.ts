import { randomInt } from "node:crypto";
import { z } from "zod";
import { createActionFactory, defineRoomModule, type ModuleContext } from "../../core/module.js";
import type { Room } from "../../core/types.js";
import { cleanText } from "../../lib/text.js";
import { chatSendSchema, pushMessage, type ChatState } from "../chat/index.js";
import { DEFAULT_CHAT_SPAM_RULES, createChatSpamGuard, type ChatSpamRules } from "../chat/spam-guard.js";

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
/** Jatah menolak jawaban per pemain per permainan. Tolakan yang terbukti benar dikembalikan. */
export const MAX_REJECTIONS = 3;
/** Game 2 pemain: satu tolakan langsung menggugurkan jawaban, jadi jatahnya lebih kecil. */
export const TWO_PLAYER_REJECTIONS = 1;
/** Alasan wajib saat menolak jawaban; ditampilkan ke semua pemain. */
export const REJECT_REASONS = ["off-category", "misspelled", "not-a-word"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
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
  /** Suara terbuka: siapa saja yang menolak jawaban ini, dan alasannya. */
  rejectedBy: { userId: string; name: string; reason: RejectReason }[];
  /** Hasil voting; `null` sampai fase voting selesai. */
  accepted: boolean | null;
  /** Perubahan skor dari jawaban ini: +1 lolos, -1 gugur (0 kalau skor sudah 0). `null` sebelum hasil. */
  points: number | null;
}

/** `retryAfterMs` ada kalau penolakan ini memulai jeda menjawab. */
export type AnswerResult = { status: "accepted" | "duplicate" | "near-tie"; retryAfterMs?: number };

/** Poin per hasil. Skor tidak pernah turun di bawah 0. */
export const POINTS = {
  accepted: 1,
  /** Lebih berat dari tidak menjawab, supaya asal menjawab tidak pernah menguntungkan. */
  rejected: -2,
  noAnswer: -1,
  /** Menolak jawaban yang lolos tanpa didukung pemain lain, setelah peringatan habis. */
  loneRejection: -1,
} as const;

/**
 * Menolak sendirian (game 3 pemain atau lebih), dihitung per permainan:
 * yang pertama diam-diam (tanpa catatan apa pun), yang kedua peringatan,
 * mulai yang ketiga dianggap sengaja dan dikenai `POINTS.loneRejection`.
 */
export const LONE_REJECTION_WARNINGS = 2;

/** Pengurangan poin di luar jawaban sendiri, ditampilkan di hasil ronde. */
export interface Penalty {
  userId: string;
  name: string;
  reason: "no-answer" | "lone-rejection";
  /** Tolakan sendirian ke berapa dalam permainan ini; `null` untuk "no-answer". */
  strike: number | null;
  /** `true` kalau baru peringatan (kartu kuning), tanpa potongan poin. */
  warning: boolean;
  /** Jawaban yang ditolak sendirian; `null` untuk "no-answer". */
  answerText: string | null;
  /** Perubahan skor yang benar-benar terjadi (0 kalau skor sudah 0). */
  points: number;
}

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
  /** Jatah tolak per pemain untuk permainan ini; ditetapkan saat permainan dimulai. */
  rejectionLimit: number;
  /** Pemain yang sudah selesai menilai di ronde ini; voting berakhir saat semua penilai selesai. */
  votingDone: string[];
  /** Hukuman di ronde ini; diisi saat hasil ronde keluar. */
  penalties: Penalty[];
  /** Jumlah tolakan sendirian per pemain dalam satu permainan; terlihat semua pemain. */
  loneRejections: Record<string, number>;
  /** Ronde berturut-turut tanpa memilih angka dan tanpa menjawab; lihat `AFK_ROUNDS`. */
  idleRounds: Record<string, number>;
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
  /** Jawaban yang ditolak (duplikat, format, huruf) sebanyak `ANSWER_RETRY_LIMIT` dalam selang ini... */
  retryWindowMs: number;
  /** ...membuat pemain harus menunggu selama ini sebelum boleh menjawab lagi. */
  retryCooldownMs: number;
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
  votingMs: 20_000,
  retryWindowMs: 5_000,
  retryCooldownMs: 3_000,
  resultMs: 5_000,
  finishedMs: 30_000,
};

/**
 * Pemain yang tidak memilih angka DAN tidak menjawab selama ronde sebanyak ini berturut-turut
 * dianggap AFK: permainan tidak menunggunya lagi. Begitu ia memilih angka atau menjawab, ia aktif lagi.
 */
export const AFK_ROUNDS = 2;

/** Lihat `AbcWordsTiming.retryWindowMs`. */
export const ANSWER_RETRY_LIMIT = 3;

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

type RoundFields =
  | "picks"
  | "reveal"
  | "answers"
  | "answeringStartedAt"
  | "lastCallUsed"
  | "graceUsedBy"
  | "votingDone"
  | "penalties";

function emptyRound(): Pick<AbcWordsState, RoundFields> {
  return {
    picks: {},
    reveal: null,
    answers: [],
    answeringStartedAt: null,
    lastCallUsed: false,
    graceUsedBy: [],
    votingDone: [],
    penalties: [],
  };
}

function isAfk(state: AbcWordsState, userId: string): boolean {
  return (state.idleRounds[userId] ?? 0) >= AFK_ROUNDS;
}

/** Pemain yang ditunggu permainan: online dan tidak AFK. */
function activePlayers(room: Room<AbcWordsState, AbcWordsSettings>) {
  return room.members.filter((m) => m.isConnected && !isAfk(room.state, m.userId));
}

/** Pemain aktif yang punya jawaban orang lain untuk dinilai. */
function judgesOf(room: Room<AbcWordsState, AbcWordsSettings>): string[] {
  const { answers } = room.state;
  return activePlayers(room)
    .filter((m) => answers.some((a) => a.userId !== m.userId))
    .map((m) => m.userId);
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
    rejectionLimit: MAX_REJECTIONS,
    loneRejections: {} as Record<string, number>,
    idleRounds: {} as Record<string, number>,
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

export function createAbcWordsModule(
  overrides: Partial<AbcWordsTiming> = {},
  chatRules: Partial<ChatSpamRules> = {},
) {
  const timing: AbcWordsTiming = { ...DEFAULT_TIMING, ...overrides };
  const chatGuard = createChatSpamGuard({ ...DEFAULT_CHAT_SPAM_RULES, ...chatRules });

  /**
   * Jawaban yang ditolak per pemain, untuk jeda menjawab. Disimpan di luar state room karena
   * `ctx.fail` membatalkan semua perubahan state, padahal penolakan justru harus tercatat.
   * Kunci: `roomId:userId`; isinya otomatis usang begitu ronde berganti.
   */
  const retries = new Map<string, { round: number; failures: number[]; until: number }>();

  function retryEntry(ctx: Ctx, userId: string) {
    const key = `${ctx.room.id}:${userId}`;
    let entry = retries.get(key);
    if (!entry || entry.round !== ctx.room.state.round) {
      entry = { round: ctx.room.state.round, failures: [], until: 0 };
      retries.set(key, entry);
    }
    return entry;
  }

  /**
   * Mencatat jawaban yang ditolak; yang ke-`ANSWER_RETRY_LIMIT` dalam selang singkat memulai jeda.
   * Mengembalikan `{ retryAfterMs }` kalau jeda baru dimulai, supaya pemain langsung tahu.
   */
  function recordRejectedAnswer(ctx: Ctx, userId: string): { retryAfterMs: number } | undefined {
    const now = ctx.now();
    // Buang catatan lama (room yang sudah selesai, jeda yang sudah lewat) supaya tidak menumpuk.
    if (retries.size > 1_000) {
      for (const [key, e] of retries) {
        if (e.until <= now && e.failures.every((at) => now - at >= timing.retryWindowMs)) retries.delete(key);
      }
    }
    const entry = retryEntry(ctx, userId);
    entry.failures = entry.failures.filter((at) => now - at < timing.retryWindowMs);
    entry.failures.push(now);
    if (entry.failures.length < ANSWER_RETRY_LIMIT) return undefined;
    entry.until = now + timing.retryCooldownMs;
    entry.failures = [];
    return { retryAfterMs: timing.retryCooldownMs };
  }

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

  /**
   * Jawaban gugur kalau lebih dari separuh pemain lain yang online menolaknya.
   * Poin (lihat `POINTS`): lolos +1, gugur -2, tidak menjawab -1, menolak sendirian jawaban yang
   * tetap lolos -1 setelah dua peringatan (hanya game 3 pemain atau lebih). Skor tidak turun di bawah 0.
   * Penolak jawaban yang gugur mendapat jatah tolaknya kembali kalau ada pemain lain yang ikut menolak;
   * penolak jawaban yang lolos tidak. Tolakan sepihak (game 2 pemain) tidak dikembalikan.
   */
  function showResult(ctx: Ctx): void {
    const { state, members } = ctx.room;
    const online = members.filter((m) => m.isConnected).map((m) => m.userId);
    /** Mengubah skor dan mengembalikan perubahan yang benar-benar terjadi. */
    const addScore = (userId: string, points: number): number => {
      const before = state.scores[userId] ?? 0;
      const after = Math.max(before + points, 0);
      state.scores[userId] = after;
      return after - before;
    };

    for (const answer of state.answers) {
      const voters = online.filter((id) => id !== answer.userId);
      const counted = answer.rejectedBy.filter((r) => voters.includes(r.userId));
      answer.accepted = counted.length * 2 <= voters.length;
      answer.points = addScore(answer.userId, answer.accepted ? POINTS.accepted : POINTS.rejected);

      if (!answer.accepted && counted.length >= 2) {
        for (const { userId } of answer.rejectedBy) {
          state.rejectionsUsed[userId] = Math.max((state.rejectionsUsed[userId] ?? 0) - 1, 0);
        }
      }
      const lone = counted[0];
      if (answer.accepted && counted.length === 1 && lone && voters.length >= 2) {
        const strike = (state.loneRejections[lone.userId] ?? 0) + 1;
        state.loneRejections[lone.userId] = strike;
        const warning = strike <= LONE_REJECTION_WARNINGS;
        // Kesalahan pertama tidak diumumkan.
        if (strike > 1) {
          state.penalties.push({
            userId: lone.userId,
            name: lone.name,
            reason: "lone-rejection",
            answerText: answer.text,
            strike,
            warning,
            points: warning ? 0 : addScore(lone.userId, POINTS.loneRejection),
          });
        }
      }
    }

    // AFK: ronde tanpa memilih angka dan tanpa menjawab dihitung berturut-turut.
    for (const member of members) {
      const picked = state.reveal?.picks.some((p) => p.userId === member.userId && !p.auto) ?? false;
      const answered = state.answers.some((a) => a.userId === member.userId);
      state.idleRounds[member.userId] = picked || answered ? 0 : (state.idleRounds[member.userId] ?? 0) + 1;
    }

    // Semua pemain di room yang tidak menjawab, termasuk yang sedang putus koneksi.
    for (const member of members) {
      if (state.answers.some((a) => a.userId === member.userId)) continue;
      state.penalties.push({
        userId: member.userId,
        name: member.name,
        reason: "no-answer",
        answerText: null,
        strike: null,
        warning: false,
        points: addScore(member.userId, POINTS.noAnswer),
      });
    }

    state.phase = "result";
    setDeadline(ctx, timing.resultMs);
  }

  function showFinalScores(ctx: Ctx): void {
    ctx.room.state.phase = "finished";
    setDeadline(ctx, timing.finishedMs);
  }

  /** Selesai kalau semua pemain aktif sudah menjawab; pemain terakhir dapat waktu sendiri. */
  function checkAnswering(ctx: Ctx): void {
    const { state } = ctx.room;
    if (state.phase !== "answering") return;
    const waitingFor = activePlayers(ctx.room).filter((m) => !state.answers.some((a) => a.userId === m.userId));
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

  /** Voting selesai lebih awal kalau semua penilai yang online sudah menekan "selesai". */
  function checkVoting(ctx: Ctx): void {
    const { state } = ctx.room;
    if (state.phase !== "voting") return;
    if (judgesOf(ctx.room).every((id) => state.votingDone.includes(id))) showResult(ctx);
  }

  /** Pemain yang putus atau AFK tidak ditunggu; server memilihkan angka untuk mereka. */
  function revealIfEveryonePicked(ctx: Ctx): void {
    const { room } = ctx;
    if (room.state.phase !== "picking") return;
    const active = activePlayers(room);
    if (active.length > 0 && active.every((m) => room.state.picks[m.userId] !== undefined)) revealLetter(ctx);
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
        rejectionsLeft: state.rejectionLimit - (viewerId === null ? 0 : (rejectionsUsed[viewerId] ?? 0)),
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
      checkVoting(ctx);
    },

    onMemberPresence(ctx) {
      watchOnlinePlayers(ctx);
      revealIfEveryonePicked(ctx);
      checkAnswering(ctx);
      checkVoting(ctx);
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
          const players = room.members.filter((m) => m.isConnected).length;
          room.state.rejectionLimit = players === 2 ? TWO_PLAYER_REJECTIONS : MAX_REJECTIONS;
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
          ctx.room.state.idleRounds[ctx.sender!.userId] = 0; // kembali aktif
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

          const { until } = retryEntry(ctx, sender.userId);
          if (now < until) {
            const retryAfterMs = until - now;
            ctx.fail(
              "SLOW_DOWN",
              `Terlalu banyak percobaan. Tunggu ${Math.ceil(retryAfterMs / 1000)} detik lagi.`,
              { retryAfterMs },
            );
          }

          const cleaned = cleanText(text);
          const key = answerKey(cleaned);
          if (!isValidAnswerKey(key)) {
            const pause = recordRejectedAnswer(ctx, sender.userId);
            ctx.fail("INVALID_ANSWER", `Jawaban harus ${ANSWER_MIN}–${ANSWER_MAX} karakter, hanya huruf dan spasi`, pause);
          }
          const letter = state.reveal!.letter;
          if (key[0]!.toUpperCase() !== letter) {
            const pause = recordRejectedAnswer(ctx, sender.userId);
            ctx.fail("WRONG_LETTER", `Jawaban harus berawalan huruf ${letter}`, pause);
          }

          const existing = state.answers.find((a) => a.key === key);
          if (existing) {
            // Keduluan tidak dihitung: itu sial, bukan menebak-nebak.
            const nearTie = now - existing.at < timing.nearTieMs && !state.graceUsedBy.includes(sender.userId);
            if (!nearTie) return { status: "duplicate", ...recordRejectedAnswer(ctx, sender.userId) };
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
            points: null,
          });
          state.idleRounds[sender.userId] = 0; // kembali aktif
          checkAnswering(ctx);
          return { status: "accepted" };
        },
      }),

      /**
       * Menolak jawaban pemain lain dengan alasan, atau membatalkannya (jatahnya kembali).
       * Menolak lagi dengan alasan lain hanya mengganti alasannya.
       */
      reject: action({
        schema: z.discriminatedUnion("rejected", [
          z.object({ answerUserId: z.string().min(1).max(128), rejected: z.literal(true), reason: z.enum(REJECT_REASONS) }),
          z.object({ answerUserId: z.string().min(1).max(128), rejected: z.literal(false) }),
        ]),
        handler(ctx, payload) {
          const { answerUserId } = payload;
          const { state } = ctx.room;
          const sender = ctx.sender!;

          if (state.phase !== "voting") ctx.fail("WRONG_PHASE", "Waktu voting sudah habis");
          if (answerUserId === sender.userId) ctx.fail("OWN_ANSWER", "Jawaban sendiri tidak bisa ditolak");
          const answer = state.answers.find((a) => a.userId === answerUserId);
          if (!answer) return ctx.fail("ANSWER_NOT_FOUND", "Jawaban tidak ditemukan");

          const index = answer.rejectedBy.findIndex((r) => r.userId === sender.userId);
          const used = state.rejectionsUsed[sender.userId] ?? 0;
          if (payload.rejected) {
            const mine = answer.rejectedBy[index];
            if (mine) {
              mine.reason = payload.reason;
              return;
            }
            if (used >= state.rejectionLimit) ctx.fail("NO_REJECTIONS_LEFT", "Jatah tolak kamu sudah habis");
            answer.rejectedBy.push({ userId: sender.userId, name: sender.name, reason: payload.reason });
            state.rejectionsUsed[sender.userId] = used + 1;
          } else if (index >= 0) {
            answer.rejectedBy.splice(index, 1);
            state.rejectionsUsed[sender.userId] = used - 1;
          }
        },
      }),

      /** Menandai (atau membatalkan) "selesai menilai"; voting berakhir saat semua penilai selesai. */
      doneVoting: action({
        schema: z.object({ done: z.boolean() }),
        handler(ctx, { done }) {
          const { state } = ctx.room;
          const userId = ctx.sender!.userId;
          if (state.phase !== "voting") ctx.fail("WRONG_PHASE", "Waktu voting sudah habis");
          if (!judgesOf(ctx.room).includes(userId)) ctx.fail("NOTHING_TO_JUDGE", "Tidak ada jawaban untuk kamu nilai");

          const index = state.votingDone.indexOf(userId);
          if (done && index < 0) state.votingDone.push(userId);
          if (!done && index >= 0) state.votingDone.splice(index, 1);
          checkVoting(ctx);
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
          const verdict = chatGuard.check(ctx.room.id, ctx.sender!.userId, text, ctx.now());
          if (!verdict.ok) {
            ctx.fail(verdict.code, verdict.message, verdict.retryAfterMs ? { retryAfterMs: verdict.retryAfterMs } : undefined);
          }
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
