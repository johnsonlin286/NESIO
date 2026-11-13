/**
 * Membatasi percobaan yang gagal (misalnya menebak password room) per kunci.
 * Setelah `maxFailures` kegagalan dalam `windowMs`, kunci itu dikunci selama `lockMs`.
 * Disimpan di memori proses; cukup untuk satu server.
 */
export class FailedAttemptLimiter {
  private readonly entries = new Map<string, { failures: number[]; lockedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
  ) {}

  /** Sisa waktu kunci dalam ms, atau 0 kalau boleh mencoba. */
  lockedFor(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.prune(now);
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((at) => now - at < this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.lockedUntil = now + this.lockMs;
      entry.failures = [];
    }
    this.entries.set(key, entry);
  }

  /** Percobaan berhasil: catatan kegagalannya dihapus. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    if (this.entries.size < 10_000) return;
    for (const [key, e] of this.entries) {
      if (e.lockedUntil <= now && e.failures.every((at) => now - at >= this.windowMs)) this.entries.delete(key);
    }
  }
}
