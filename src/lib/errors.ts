import type { ErrorCode, ErrorPayload } from "../shared/contract.js";

/**
 * Error yang aman ditampilkan ke client. Error lain (bug, crash) akan
 * diubah menjadi INTERNAL_ERROR tanpa membocorkan detail.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

export const Errors = {
  validation: (details?: unknown) => new AppError("VALIDATION_ERROR", "Data yang dikirim tidak valid", details),
  unauthorized: (message = "Tidak terautentikasi") => new AppError("UNAUTHORIZED", message),
  rateLimited: () => new AppError("RATE_LIMITED", "Terlalu banyak request, coba lagi sebentar"),
  roomNotFound: () => new AppError("ROOM_NOT_FOUND", "Room tidak ditemukan"),
  roomFull: () => new AppError("ROOM_FULL", "Room sudah penuh"),
  roomLocked: () => new AppError("ROOM_LOCKED", "Room sedang terkunci"),
  invalidPassword: () => new AppError("INVALID_PASSWORD", "Password room salah"),
  alreadyInRoom: (roomId: string) => new AppError("ALREADY_IN_ROOM", "Kamu sudah berada di room lain", { roomId }),
  notInRoom: () => new AppError("NOT_IN_ROOM", "Kamu tidak sedang berada di room"),
  notHost: () => new AppError("NOT_HOST", "Hanya host yang boleh melakukan ini"),
  memberNotFound: () => new AppError("MEMBER_NOT_FOUND", "Member tidak ditemukan di room ini"),
  unknownRoomType: (type: string) => new AppError("UNKNOWN_ROOM_TYPE", `Tipe room "${type}" tidak dikenal`),
  unknownAction: (action: string) => new AppError("UNKNOWN_ACTION", `Action "${action}" tidak dikenal`),
  internal: () => new AppError("INTERNAL_ERROR", "Terjadi kesalahan pada server"),
};
