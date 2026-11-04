// Owner: WP-R. Run async jobs a few at a time; results come back in input order (stable output).

/** Default number of promises `rule propose --all` asks the model about at once (R4-FIX: 4 -> 8, `--concurrency`). */
export const DEFAULT_CONCURRENCY = 8;
/** The most `--concurrency` accepts. */
export const MAX_CONCURRENCY = 16;

/**
 * Runs `fn` over `items` with at most `limit` jobs in flight. Jobs start in input order. `onDone` is called as each job
 * finishes (finish order, with how many are done so far). The returned array is in input order. A job that throws
 * rejects the whole call after the jobs already started have settled.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onDone?: (result: R, item: T, index: number, doneCount: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next;
      next += 1;
      try {
        const result = await fn(items[index] as T, index);
        results[index] = result;
        done += 1;
        onDone?.(result, items[index] as T, index, done);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}
