/** Rate limiter fixed-window sederhana untuk satu koneksi socket. */
export class FixedWindowLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** `true` jika request boleh diproses. */
  tryConsume(now = Date.now()): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return this.count <= this.max;
  }
}
