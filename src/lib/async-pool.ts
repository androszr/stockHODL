/**
 * Bounded-concurrency map, pure and isomorphic — zero dependencies, no
 * `server-only` (nothing here touches env, the DB or a vendor; the CALLERS
 * are server modules).
 *
 * Contract:
 * - Results come back in INPUT order, always — each worker writes its result
 *   at the item's original index, so settle order can never reorder them.
 * - At most `limit` invocations of `fn` are in flight at once; workers pull
 *   the next item off a shared cursor, so start order is input order too.
 * - `fn` receives the item's ORIGINAL index (callers key per-index behavior,
 *   e.g. the daily-backfill bound in `portfolio-series.ts`, off it).
 * - A rejection from `fn` PROPAGATES to the caller — the same doctrine as the
 *   Tier 1 `Promise.all` in `live-view.ts`: the pooled task functions in this
 *   repo are never-throw by contract (they catch and degrade internally), so
 *   a propagated rejection here is a programming error surfacing, not a
 *   runtime hazard to swallow.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  // Degenerate limits still make progress: anything below 1 runs like 1.
  //
  // NaN is checked FIRST and separately, because it does not merely round
  // badly — it propagates silently all the way to a wrong-shaped success.
  // Math.max(1, NaN) is NaN, Array.from({length: NaN}) is [], so zero workers
  // spawn, Promise.all([]) resolves immediately, and the caller receives a
  // full-length array of holes with no throw and no work done — an empty
  // chart that looks like an answer. Not reachable from today's two callers
  // (both pass the HISTORY_CONCURRENCY literal), but this is a generic
  // utility and a future caller computing its limit (a ratio over an empty
  // list, an unset env var) would land here.
  const workerCount = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), items.length)
    : 1;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
