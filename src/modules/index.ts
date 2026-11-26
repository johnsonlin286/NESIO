import type { AnyRoomModule } from "../core/module.js";
import { createAbcWordsModule, type AbcWordsDeps } from "./abc-words/index.js";
import { chatModule } from "./chat/index.js";
import { numberGuessModule } from "./number-guess/index.js";

/**
 * Daftar module (logic spesifik project) yang aktif.
 * Module pertama = tipe room default ketika client tidak mengirim `type`.
 *
 * Saat fork untuk project baru: buat folder di `src/modules/<nama>/`,
 * daftarkan di sini, dan hapus contoh yang tidak dipakai.
 */
export function createModules(deps: AbcWordsDeps = {}): AnyRoomModule[] {
  return [chatModule, numberGuessModule, createAbcWordsModule({}, {}, deps)];
}

export const modules: AnyRoomModule[] = createModules();
