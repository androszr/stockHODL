import type { SessionTimes } from '@/lib/market-data/market-clock';

/**
 * Whether a daily chart range should grow an in-memory last point for today.
 *
 * Injected `session` / `nowMs` / `todayISO` — no clock reads inside, so a
 * weekend, a holiday (`session === null`), and a weekday all take the same
 * path. Premarket is skipped: the headline last is still yesterday's close
 * until regular open, and drawing that as today would invent a flat day.
 * Once snapshots already contain `todayISO`, overlaying again would
 * duplicate the last `t`.
 */
export function shouldOverlayFormingDay(input: {
  todayISO: string;
  nowMs: number;
  session: SessionTimes | null;
  existingDates: Iterable<string>;
}): boolean {
  const { todayISO, nowMs, session, existingDates } = input;
  if (session === null) return false;
  if (nowMs < session.openMs) return false;
  for (const date of existingDates) {
    if (date === todayISO) return false;
  }
  return true;
}
