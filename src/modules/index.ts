import type { AnyRoomModule } from "../core/module.js";
import { chatModule } from "./chat/index.js";
import { numberGuessModule } from "./number-guess/index.js";

/**
 * Daftar module (logic spesifik project) yang aktif.
 * Module pertama = tipe room default ketika client tidak mengirim `type`.
 *
 * Saat fork untuk project baru: buat folder di `src/modules/<nama>/`,
 * daftarkan di sini, dan hapus contoh yang tidak dipakai.
 */
export const modules: AnyRoomModule[] = [chatModule, numberGuessModule];
