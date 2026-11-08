/**
 * Menjalankan task dengan key yang sama secara berurutan (satu per satu).
 * Dipakai supaya dua event untuk room yang sama tidak saling menimpa
 * (mis. dua orang join bersamaan ke slot terakhir).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
