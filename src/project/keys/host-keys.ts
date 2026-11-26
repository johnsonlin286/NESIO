import type { Logger } from "../../lib/logger.js";
import type { HostKeys } from "../../modules/abc-words/index.js";
import type { AppServer } from "../../socket/types.js";
import { ACCOUNT_NAME_CLAIM } from "../player-names.js";
import { noRoomKeysError, type RoomKeyService } from "./service.js";

/**
 * Menghubungkan game dengan kunci akun. Hanya koneksi aplikasi (identity punya klaim akun) yang
 * membayar; tamu web gratis dan tidak menyentuh database, jadi tetap jalan kalau database bermasalah.
 */
export function createHostKeys(service: RoomKeyService, io: () => AppServer, logger: Logger): HostKeys {
  const isAccount = (userId: string) =>
    [...io().of("/").sockets.values()].some(
      ({ data }) => data.identity?.userId === userId && typeof data.identity.claims?.[ACCOUNT_NAME_CLAIM] === "string",
    );

  return {
    async ensureAvailable(userId) {
      if (!isAccount(userId)) return;
      const { count, nextAt } = await service.status(userId);
      if (count <= 0) throw noRoomKeysError(nextAt);
    },
    async spend(userId) {
      if (!isAccount(userId)) return false;
      await service.spend(userId);
      return true;
    },
    async refund(userId) {
      try {
        await service.refund(userId);
      } catch (error) {
        // Akun sudah dihapus atau database bermasalah: server tetap berhenti.
        logger.error({ err: error, userId }, "room key refund failed");
      }
    },
  };
}
