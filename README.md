# Socket Room Boilerplate

Boilerplate backend **Node.js + Express + Socket.IO + TypeScript** untuk aplikasi realtime berbasis room
(game multiplayer, chat, quiz, watch party, dll). Logic yang selalu berulang sudah jadi:

- create / join / leave / close room, kode room 6 karakter, password, room publik/privat
- host: kick, transfer host, update settings; host keluar → **migrate** atau **close** (bisa diatur)
- **masalah jaringan**: status online/offline, masa tunggu reconnect, otomatis masuk lagi ke room
  setelah reconnect (tanpa event "rejoin"), dukungan multi-tab/multi-device
- identitas aman: **guest** (session token bertanda tangan) atau **JWT** (secret / JWKS: Firebase, Supabase, Auth0, Clerk)
- semua event memakai **acknowledgement** dengan format `{ ok, data | error: { code, message } }`
- validasi zod, rate limit HTTP & socket, helmet, CORS allowlist, batas ukuran payload
- garbage collector room yang idle, graceful shutdown
- **module system**: logic khusus project ditulis sebagai module tanpa menyentuh core

Client apa pun yang memakai `socket.io-client` bisa dipakai: Next.js, React, Vue, React Native/Expo, Flutter (socket_io_client).

---

## Mulai cepat

```bash
npm install
cp .env.example .env
npm run dev          # nodemon + tsx, auto-restart
```

| Script              | Fungsi                                  |
| ------------------- | --------------------------------------- |
| `npm run dev`       | Development server (watch `src` & `.env`) |
| `npm run build`     | Compile ke `dist/`                      |
| `npm start`         | Jalankan hasil build                    |
| `npm test`          | Integration test (vitest)               |
| `npm run typecheck` | Cek tipe tanpa build                    |

## Struktur folder

```
src/
├── index.ts                 # entry point: load env, start server, shutdown
├── server.ts                # createRoomServer() — merakit semua bagian
├── config/env.ts            # validasi environment (zod)
├── shared/contract.ts       # ⭐ kontrak event & tipe — copy ke project client
├── core/                    # ❗ jarang perlu diubah
│   ├── room-service.ts      # semua logic room (create/join/leave/host/...)
│   ├── presence.ts          # online/offline + masa tunggu reconnect
│   ├── module.ts            # API untuk membuat module
│   └── store/               # RoomStore (interface) + MemoryRoomStore
├── auth/                    # guest & JWT authenticator
├── socket/                  # handler Socket.IO (validasi, rate limit, ack)
├── http/                    # Express: helmet, cors, rate limit, /health, /api/rooms
├── lib/                     # utilitas (error, logger, mutex, password, dll)
└── modules/                 # ✏️ logic khusus project ada di sini
    ├── index.ts             # daftar module aktif
    ├── chat/                # contoh: chat room
    └── number-guess/        # contoh: game tebak angka
test/                        # integration test end-to-end
```

**Saat fork untuk project baru:** buat module di `src/modules/<nama>/`, daftarkan di `src/modules/index.ts`,
hapus contoh yang tidak dipakai. Folder `core/`, `socket/`, `auth/` tidak perlu disentuh.

---

## Kontrak event

Semua tipe ada di [src/shared/contract.ts](src/shared/contract.ts). File ini tanpa dependency,
jadi **copy saja ke project client** supaya event & payload ter-type di kedua sisi.

### Client → Server (semua memakai ack)

| Event                | Payload                                                              | Balasan (`data`)   | Catatan                   |
| -------------------- | -------------------------------------------------------------------- | ------------------ | ------------------------- |
| `session:get`        | –                                                                    | `SessionInfo`      |                           |
| `room:create`        | `{ type?, name?, maxMembers?, isPublic?, password?, settings?, displayName?, avatar? }` | `RoomView` |                           |
| `room:join`          | `{ roomId, password?, displayName?, avatar? }`                       | `RoomView`         | idempotent                |
| `room:leave`         | –                                                                    | `null`             |                           |
| `room:sync`          | –                                                                    | `RoomView \| null` | ambil state terbaru       |
| `room:kick`          | `{ userId }`                                                         | `null`             | host                      |
| `room:transfer-host` | `{ userId }`                                                         | `null`             | host                      |
| `room:update`        | `{ name?, maxMembers?, isPublic?, password?, settings? }`            | `RoomView`         | host                      |
| `room:close`         | –                                                                    | `null`             | host                      |
| `room:action`        | `{ action, payload? }`                                               | hasil dari module  | pintu masuk logic module  |

Identitas user selalu diambil dari koneksi (bukan dari payload), dan satu user hanya bisa berada di satu room.
Karena itu payload tidak perlu `roomId` / `email` / `socketId`, dan client tidak bisa berpura-pura menjadi user lain.

### Server → Client

| Event                  | Kapan                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| `session`              | setiap kali koneksi berhasil (berisi `userId`, `sessionToken`, `roomId`) |
| `room:state`           | **snapshot lengkap room**; cukup simpan ini di store client              |
| `room:member-joined`   | member baru masuk                                                       |
| `room:member-left`     | member keluar (`reason`: `left` / `kicked` / `timeout`)                 |
| `room:member-presence` | member offline / online lagi                                            |
| `room:host-changed`    | host berpindah                                                          |
| `room:kicked`          | kamu di-kick                                                            |
| `room:closed`          | room ditutup (`host-left` / `closed-by-host` / `idle` / `server-shutdown`) |
| `room:event`           | event custom dari module: `{ event, data }`                              |

Event notifikasi hanya untuk toast/sfx. Sumber kebenaran tetap `room:state`.

### Kode error

`VALIDATION_ERROR`, `UNAUTHORIZED`, `RATE_LIMITED`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_LOCKED`,
`INVALID_PASSWORD`, `ALREADY_IN_ROOM`, `NOT_IN_ROOM`, `NOT_HOST`, `MEMBER_NOT_FOUND`,
`UNKNOWN_ROOM_TYPE`, `UNKNOWN_ACTION`, `INTERNAL_ERROR`, ditambah kode custom dari module
(mis. `NOT_ENOUGH_PLAYERS`). Client sebaiknya memakai `code`, bukan mencocokkan teks `message`.

### REST API

| Method | Path              | Fungsi                                   |
| ------ | ----------------- | ---------------------------------------- |
| GET    | `/health`         | health check                             |
| GET    | `/api/rooms`      | daftar room publik (`RoomSummary[]`)     |
| GET    | `/api/rooms/:id`  | ringkasan room (untuk halaman invite)    |

Route tambahan bisa didaftarkan lewat opsi `registerRoutes` di `createRoomServer()`.

---

## Contoh client

### Next.js / React (web)

```ts
// lib/socket.ts
"use client";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents, AckResponse } from "./contract"; // hasil copy

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

export function getSocket(): AppSocket {
  if (socket) return socket;
  socket = io(process.env.NEXT_PUBLIC_API_URL!, {
    autoConnect: false,
    // Dibaca ulang setiap kali (re)connect, jadi token terbaru selalu terkirim.
    auth: (cb) =>
      cb({
        sessionToken: localStorage.getItem("sessionToken") ?? undefined,
        name: localStorage.getItem("playerName") ?? undefined,
      }),
  });
  socket.on("session", (session) => {
    if (session.sessionToken) localStorage.setItem("sessionToken", session.sessionToken);
  });
  return socket;
}

/** Helper: emit + ack -> Promise, lempar error dengan `code`. */
export async function request<T>(event: keyof ClientToServerEvents, payload?: unknown): Promise<T> {
  const s = getSocket().timeout(5000) as any;
  const res: AckResponse<T> = payload === undefined ? await s.emitWithAck(event) : await s.emitWithAck(event, payload);
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data;
}
```

```tsx
// contoh pemakaian
const socket = getSocket();
socket.connect();

socket.on("room:state", (room) => useRoomStore.getState().setRoom(room));
socket.on("room:closed", () => router.push("/"));
socket.on("room:event", ({ event, data }) => {
  if (event === "chat:message") appendMessage(data);
});

const room = await request<RoomView>("room:create", { type: "chat", name: "Ruang Santai" });
await request("room:join", { roomId: "ABC123" });
await request("room:action", { action: "send", payload: { text: "halo" } });
```

Saat reconnect, server otomatis mengembalikan user ke room dan mengirim `room:state`.
Tidak perlu `room:rejoin` di halaman play. Kalau ingin memastikan state segar setelah tab kembali aktif,
panggil `request("room:sync")`.

### React Native / Expo

Sama persis, hanya penyimpanan token dan transport yang berbeda:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

socket = io(API_URL, {
  transports: ["websocket"], // RN lebih stabil tanpa long-polling
  autoConnect: false,
  auth: (cb) => {
    AsyncStorage.getItem("sessionToken").then((sessionToken) => cb({ sessionToken: sessionToken ?? undefined }));
  },
});
socket.on("session", (s) => s.sessionToken && AsyncStorage.setItem("sessionToken", s.sessionToken));

// App kembali dari background -> pastikan connect & sinkron
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    if (!socket.connected) socket.connect();
    else request("room:sync").then((room) => room && setRoom(room));
  }
});
```

React Native tidak mengirim header `Origin`, jadi tidak terpengaruh CORS.

---

## Membuat module (logic project)

Module = semua yang khusus untuk aplikasi Anda: state room, aksi, dan aturan.
Lihat contoh lengkap di [src/modules/number-guess/index.ts](src/modules/number-guess/index.ts).

```ts
// src/modules/quiz/index.ts
import { z } from "zod";
import { createActionFactory, defineRoomModule } from "../../core/module.js";

interface QuizState { phase: "lobby" | "question" | "result"; scores: Record<string, number>; answer: string | null }
const settingsSchema = z.object({ rounds: z.number().int().min(1).max(20).default(5) });
type QuizSettings = z.infer<typeof settingsSchema>;

const action = createActionFactory<QuizState, QuizSettings>();

export const quizModule = defineRoomModule<QuizState, QuizSettings>({
  type: "quiz",
  settingsSchema,                          // divalidasi saat create & room:update
  maxMembers: { min: 2, max: 12, default: 8 },
  hostLeavePolicy: "migrate",              // opsional, override global
  reconnectGraceMs: 60_000,                // opsional, override global

  createState: () => ({ phase: "lobby", scores: {}, answer: null }),

  // Sembunyikan data rahasia per penerima
  serializeState: (state, viewerId) => ({ ...state, answer: state.phase === "result" ? state.answer : null }),

  onMemberJoin(ctx, member) { ctx.room.state.scores[member.userId] = 0; },
  onMemberLeave(ctx, member) { delete ctx.room.state.scores[member.userId]; },

  actions: {
    start: action({
      hostOnly: true,
      handler(ctx) {
        if (ctx.room.members.length < 2) ctx.fail("NOT_ENOUGH_PLAYERS", "Minimal 2 pemain");
        ctx.room.state.phase = "question";
        ctx.setLocked(true);               // tolak member baru selama game
        ctx.emit("quiz:started");           // ke semua member
      },
    }),
    answer: action({
      schema: z.object({ choice: z.string().max(100) }),
      handler(ctx, { choice }) {
        // ctx.sender = member yang mengirim
        ctx.emitTo(ctx.sender!.userId, "quiz:your-result", { correct: choice === ctx.room.state.answer });
        return { received: true };          // dikirim sebagai `data` di ack
      },
    }),
  },
});
```

Lalu daftarkan di `src/modules/index.ts`. Client memakai `room:create { type: "quiz" }` dan
`room:action { action: "start" }`.

Aturan penting:

- Ubah `ctx.room.state` langsung. Perubahan disimpan dan `room:state` dikirim otomatis setelah handler sukses
  (set `sync: false` pada action yang sangat sering, lalu pakai `ctx.emit`).
- Jika handler melempar error (`ctx.fail(...)`), **semua perubahan dibatalkan** dan event tidak terkirim.
- Event untuk room yang sama diproses berurutan (ada mutex per room), jadi tidak ada race condition.
- State harus berupa data biasa (bisa `structuredClone`): tanpa function, class, `Map`/`Set` sebaiknya dihindari.
- Butuh timer (mis. countdown ronde)? Simpan `deadline` (epoch ms) di state, tampilkan countdown di client,
  dan validasi `ctx.now() > deadline` di action berikutnya. Timer server-side belum disediakan core.

---

## Auth

### Guest (default)

Tanpa login. Server membuat `userId` dan `sessionToken` (HMAC dengan `SESSION_SECRET`).
Client menyimpan token lalu mengirimnya lagi lewat `auth.sessionToken`, sehingga identitas tetap sama
saat refresh atau reconnect. Token palsu atau token dari secret lama akan diperlakukan sebagai user baru.

### JWT

```
AUTH_MODE=jwt
JWT_SECRET=...                  # HS256, token dibuat oleh backend Anda sendiri
# atau
JWT_JWKS_URL=https://...        # Firebase / Supabase / Auth0 / Clerk / Cognito
JWT_ISSUER=...
JWT_AUDIENCE=...
```

Client mengirim `io(URL, { auth: { token } })`. `sub` → userId, `name`/`email` → nama, `picture` → avatar.

> **NextAuth**: token session NextAuth terenkripsi (JWE), jadi tidak bisa diverifikasi langsung.
> Buat route di Next.js yang menandatangani JWT pendek (HS256, `sub` = id/email user) dengan `JWT_SECRET`
> yang sama, lalu kirim token itu saat connect.

### Custom

```ts
createRoomServer({
  config, modules,
  authenticator: async ({ auth, headers, ip }) => {
    const user = await verifyWithYourProvider(auth.token);
    return { identity: { userId: user.id, name: user.name, avatar: user.photo }, sessionToken: null };
  },
});
```

---

## Masalah jaringan: apa yang terjadi

1. Koneksi terakhir user putus → member ditandai `isConnected: false`, room menerima `room:member-presence`.
   Ping server 10s/10s, jadi koneksi mati terdeteksi dalam ±20 detik (penting untuk mobile).
2. Server menunggu `RECONNECT_GRACE_MS` (default 30 detik).
3. User connect lagi dengan identitas yang sama → otomatis masuk kembali ke room, menerima `session` (dengan `roomId`)
   dan `room:state`, dan member lain menerima `room:member-presence` online.
4. Kalau tidak kembali → dikeluarkan dengan `reason: "timeout"`. Jika dia host, berlaku `HOST_LEAVE_POLICY`.

User yang membuka beberapa tab/device dihitung online selama masih ada satu koneksi.

## Keamanan yang sudah terpasang

- Identitas dari handshake (session token bertanda tangan / JWT), bukan dari payload
- Semua payload divalidasi zod, teks dibersihkan dari karakter tak terlihat
- Aksi host dicek di server; state rahasia difilter per penerima (`serializeState`)
- Password room di-hash dengan scrypt dan dibandingkan secara timing-safe
- Rate limit per koneksi socket dan per IP untuk REST, batas ukuran payload
- Helmet, CORS allowlist (wajib di production), error internal tidak dibocorkan
- `SESSION_SECRET` dan `CORS_ORIGIN` wajib di production (server menolak start)

Untuk production: jalankan di belakang HTTPS (reverse proxy) dan set `TRUST_PROXY=1`.

## Scaling

Default berjalan di **satu instance** (in-memory). Room hilang saat server restart; client akan menerima
`session.roomId = null` dan bisa kembali ke halaman awal.

Untuk multi-instance:

1. Implementasikan `RoomStore` ([src/core/store/room-store.ts](src/core/store/room-store.ts)) dengan Redis
   dan kirim lewat `createRoomServer({ store })`.
2. Pasang `@socket.io/redis-adapter` di `io`.
3. Gunakan sticky session di load balancer, dan ganti mutex in-process dengan distributed lock
   (atau route semua user satu room ke instance yang sama).

## Testing

```bash
npm test
```

Integration test di `test/` menjalankan server sungguhan dan client `socket.io-client`, mencakup
lifecycle room, hak host, reconnect/timeout, multi-tab, kedua module contoh, REST, JWT, dan rate limit.
Gunakan `test/helpers.ts` untuk menulis test module Anda sendiri.
