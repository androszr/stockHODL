import type { ChartPoint } from '@/lib/charts/series';
import { dec } from '@/lib/money';

/**
 * In-memory daily point for today's still-forming session. Pure — no I/O,
 * no `server-only`. `v` is the live last via `dec()`; `o`/`h`/`l` ride only
 * when all three are non-null decimal strings (the instrument series'
 * all-three-or-none contract).
 */
export function equityOverlayPoint(input: {
  todayISO: string;
  last: string;
  open?: string | null;
  high?: string | null;
  low?: string | null;
}): ChartPoint {
  const point: ChartPoint = {
    t: Date.parse(`${input.todayISO}T00:00:00Z`),
    v: dec(input.last).toString(),
  };
  const { open, high, low } = input;
  if (typeof open === 'string' && typeof high === 'string' && typeof low === 'string') {
    const lastDec = dec(input.last);
    const highDec = dec(high);
    const lowDec = dec(low);
    // A close outside the wick is a line vertex, not a candle — omit o/h/l
    // rather than inventing clamp math on money.
    if (!lastDec.lt(lowDec) && !lastDec.gt(highDec)) {
      point.o = dec(open).toString();
      point.h = highDec.toString();
      point.l = lowDec.toString();
    }
  }
  return point;
}

/**
 * Copy-on-write: today's live last onto each instrument that does not
 * already have that date. Instruments absent from `lastByInstrumentId` stay
 * as they were (carry-forward inside the daily builder). Never mutates the
 * input maps — analytics TWRR reads the unpatched closes.
 */
export function patchDailyCloses(
  closesByInstrument: ReadonlyMap<string, ReadonlyMap<string, string>>,
  todayISO: string,
  lastByInstrumentId: ReadonlyMap<string, string>,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [id, closes] of closesByInstrument) {
    const copy = new Map(closes);
    const last = lastByInstrumentId.get(id);
    // Empty maps stay empty: a cache miss / read failure / past-backfill
    // bound must keep the instrument in excludedSymbols, not mint a
    // one-day series from a live last.
    if (last !== undefined && copy.size > 0 && !copy.has(todayISO)) {
      copy.set(todayISO, dec(last).toString());
    }
    out.set(id, copy);
  }
  return out;
}
