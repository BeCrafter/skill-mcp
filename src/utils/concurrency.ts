/**
 * Run an async map over `items` with at most `concurrency` in flight at once.
 * Preserves input order in the output. Fails fast on the first rejection.
 */
export async function pMap<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency <= 0) throw new Error("concurrency must be > 0");
  if (items.length === 0) return [];
  const limit = Math.min(concurrency, items.length);
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed: unknown = null;

  async function runner(): Promise<void> {
    while (failed === null) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        failed = e;
        throw e;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  if (failed !== null) throw failed;
  return results;
}
