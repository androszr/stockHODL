import { addDaysIso } from '@/lib/dates';
import {
  lastCompletedSessionDateISO,
  nyDateISOAt,
  regularSessionFor,
  type CalendarOverride,
} from '@/lib/market-data/market-clock';

export interface DayReportBounds {
  earliest: string;
  latest: string;
}

export function dayReportBounds(input: {
  nowMs: number;
  overrides: readonly CalendarOverride[];
  firstTradeDate: string;
}): DayReportBounds | null {
  const { nowMs, overrides, firstTradeDate } = input;
  const today = nyDateISOAt(nowMs);
  const todaySession = regularSessionFor(today, overrides);
  const completed = lastCompletedSessionDateISO(nowMs, overrides);
  const latest = todaySession && nowMs < todaySession.closeMs ? today : completed;
  if (latest === null || firstTradeDate > latest) return null;

  let earliest = firstTradeDate;
  for (let scanned = 0; scanned <= 14 && !regularSessionFor(earliest, overrides); scanned++) {
    earliest = addDaysIso(earliest, 1);
  }
  if (!regularSessionFor(earliest, overrides) || earliest > latest) return null;
  return { earliest, latest };
}

export function isReportableDay(
  dayISO: string,
  bounds: DayReportBounds,
  overrides: readonly CalendarOverride[],
): boolean {
  return dayISO >= bounds.earliest && dayISO <= bounds.latest && regularSessionFor(dayISO, overrides) !== null;
}

export function adjacentSessionDays(
  dayISO: string,
  bounds: DayReportBounds,
  overrides: readonly CalendarOverride[],
): { prev: string | null; next: string | null } {
  const scan = (step: -1 | 1): string | null => {
    let candidate = dayISO;
    for (let i = 0; i < 14; i++) {
      candidate = addDaysIso(candidate, step);
      if (candidate < bounds.earliest || candidate > bounds.latest) return null;
      if (regularSessionFor(candidate, overrides)) return candidate;
    }
    return null;
  };
  return { prev: scan(-1), next: scan(1) };
}

export type SegmentAvailability = {
  morning: 'ready' | 'none';
  close: 'ready' | 'market_open' | 'not_ready';
};

/**
 * The morning half exists for every session day that has begun, at any hour:
 * it is the state BEFORE the open (previous close + overnight news, capped at
 * the bell by the view), and that snapshot does not stop being true once
 * the market opens. The old shape hid today's morning report from the open
 * until midnight while showing yesterday's — a hole the pre-open cron fell
 * into whenever it missed its window. Only the close half is time-gated.
 */
export function segmentAvailability(
  dayISO: string,
  nowMs: number,
  overrides: readonly CalendarOverride[],
): SegmentAvailability {
  const session = regularSessionFor(dayISO, overrides);
  if (!session) return { morning: 'none', close: 'not_ready' };
  const today = nyDateISOAt(nowMs);
  if (dayISO > today) return { morning: 'none', close: 'not_ready' };
  if (dayISO === today && nowMs < session.closeMs) {
    return { morning: 'ready', close: 'market_open' };
  }
  return { morning: 'ready', close: 'ready' };
}
