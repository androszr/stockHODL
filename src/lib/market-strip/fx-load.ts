import 'server-only';

import { resolveRange } from '@/lib/charts/ranges';
import { addDaysIso } from '@/lib/dates';
import { massiveProvider } from '@/lib/market-data/massive';
import type { Candle } from '@/lib/market-data/provider';

import { composeFxFigures, FX_TICKER, NULL_FX_FIGURES, utcDateISOAt, type FxFigures } from './fx';

/**
 * The impure half of the USD/PLN tile: two aggregates calls, sequential
 * (the provider doctrine forbids fanning out), each best-effort. A vendor
 * failure yields the null figures and one console line — never a throw,
 * because the tile is decoration above someone's money and must never take
 * the strip down with it.
 *
 * `C:USDPLN` goes ONLY to `getAggregates`. It is never added to the snapshot
 * batch (`INDEX_PROXY_SYMBOLS`), the socket, or any stored row — the
 * snapshot endpoint is NOT_ENTITLED for it, and no `instruments` row exists
 * for a currency. The `massive.ts` 60 s in-process cache for minute bars
 * bounds the cost of the strip's once-a-minute poll.
 *
 * Both windows are UTC-dated (see `fx.ts` for why the forex day is the UTC
 * clock day): `resolveRange('1D')` is New York-agnostic in its arithmetic —
 * it only turns `today` into a wide-enough epoch window — so handing it the
 * UTC date is correct; the NYSE-session slicing happens in `fx.ts`, and it
 * does not, by construction.
 */

/** Calendar slack in front of the 1D window so `resolveRange` never clamps. */
const ANCHOR_LOOKBACK_DAYS = 30;
/** Daily bars back far enough that a holiday-adjacent Monday still has a base. */
// Ten calendar days cover the day-move base AND the five-day strip (six bars) with slack.
const DAILY_LOOKBACK_DAYS = 12;

async function fetchIntraday(todayISO: string): Promise<Candle[]> {
  const resolved = resolveRange('1D', {
    today: todayISO,
    anchorDate: addDaysIso(todayISO, -ANCHOR_LOOKBACK_DAYS),
  });
  if (resolved === null || resolved.kind !== 'intraday') return [];

  return massiveProvider.getAggregates(FX_TICKER, {
    multiplier: resolved.multiplier,
    timespan: 'minute',
    from: String(resolved.fromMs),
    to: String(resolved.toMs),
  });
}

async function fetchDaily(todayISO: string): Promise<Candle[]> {
  return massiveProvider.getAggregates(FX_TICKER, {
    multiplier: 1,
    timespan: 'day',
    from: addDaysIso(todayISO, -DAILY_LOOKBACK_DAYS),
    to: todayISO,
  });
}

/** One best-effort call: a throw becomes `[]` and a console line. */
async function bestEffort(label: string, call: () => Promise<Candle[]>): Promise<Candle[]> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : `${label} fetch failed`;
    console.error(`Market strip fx ${label} failed (${FX_TICKER}): ${message}`);
    return [];
  }
}

/**
 * Each call is wrapped ON ITS OWN, so a daily failure still leaves the rate
 * and the spark (measured to the tip) and only the day move goes null;
 * `composeFxFigures` already degrades per input. Never throws.
 */
export async function fetchFxTile(): Promise<FxFigures> {
  const todayISO = utcDateISOAt(Date.now());
  const intraday = await bestEffort('intraday', () => fetchIntraday(todayISO));
  if (intraday.length === 0) return { ...NULL_FX_FIGURES, spark: [] };
  const daily = await bestEffort('daily', () => fetchDaily(todayISO));
  return composeFxFigures(daily, intraday);
}
