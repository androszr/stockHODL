import { eq, min } from 'drizzle-orm';

import { cronGate } from '@/lib/api/cron/gate';
import { db, instruments, optionPositions, transactions, user, watchlist } from '@/lib/db';
import { syncDividends } from '@/lib/dividends/sync';
import { env } from '@/lib/env';
import { instrumentAnchorDate } from '@/lib/history/anchor';
import { planBackfillRun } from '@/lib/history/backfill-budget';
import { backfillDailyHistory } from '@/lib/history/price-history';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import {
  backfillOptionDailyCloses,
  optionBackfilledWindows,
  optionCloseFloors,
  syncOptionDailyCloses,
} from '@/lib/options/close-sync';
import { recordOptionMarks } from '@/lib/options/mark-sync';
import { optionBackfillFrom } from '@/lib/options/ny-dates';
import { watchedAnchorDate } from '@/lib/watchlist/anchor';

/**
 * Vercel Cron target (see vercel.json — 23:30 UTC on weekdays, after the US
 * close): pulls each held instrument's daily closes from its coverage edge
 * through the last completed session, so `price_snapshots` stays current even
 * on days nobody opens a chart. Internet-reachable, so it authenticates with
 * `Authorization: Bearer ${CRON_SECRET}` — the header Vercel Cron sends when
 * the env var is set (the same discipline as refresh-symbols).
 *
 * The check itself is the shared `cronGate` (`src/lib/api/cron/gate.ts`):
 * 503 without a configured secret, 401 on any other header, and error bodies
 * that tell strangers nothing.
 *
 * The sync is sequential (the per-symbol aggs endpoint must not be fanned
 * out), best-effort (`backfillDailyHistory` logs and degrades instead of
 * throwing — one failing instrument never sinks the run) and bounded.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  const refused = cronGate(request, env().CRON_SECRET);
  if (refused) return refused;

  try {
    // Every instrument with at least one transaction, plus its first trade
    // date — the left edge of the wanted window. `missingRanges` inside the
    // sync reduces an up-to-date instrument to a single new-day gap (or none),
    // and the completed-session clamp keeps a still-running session out.
    const held = await db
      .select({
        id: instruments.id,
        symbol: instruments.symbol,
        currency: instruments.currency,
        firstTradeDate: min(transactions.tradeDate),
      })
      .from(transactions)
      .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
      .groupBy(instruments.id, instruments.symbol, instruments.currency)
      .orderBy(instruments.symbol);

    const today = nyDateISOAt(Date.now());

    // Watched instruments join the run (2026-08-14) so their charts stay as
    // warm as owned ones. No first trade to anchor on — the fixed 5-year
    // watched policy bounds the window. Dedup by id: an instrument both held
    // and watched keeps its (earlier-anchored) held entry. Best-effort around
    // the table itself: a not-yet-applied migration must not sink the run.
    let watchedRows: { id: string; symbol: string; currency: string }[] = [];
    try {
      watchedRows = await db
        .select({
          id: instruments.id,
          symbol: instruments.symbol,
          currency: instruments.currency,
        })
        .from(watchlist)
        .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id))
        .orderBy(instruments.symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'watchlist select failed';
      console.error(`[cron/refresh-history] watched selection failed: ${message}`);
    }
    const seen = new Set(held.map((r) => r.id));
    const watchedFrom = watchedAnchorDate(today);
    const watchedMapped = watchedRows
      .filter((w) => {
        if (seen.has(w.id)) return false;
        seen.add(w.id);
        return true;
      })
      .map((w) => ({ ...w, firstTradeDate: watchedFrom }));

    // The budget replaces a blind `.slice(0, 50)` that starved watched
    // instruments forever once held reached the cap (fix of 2026-08-14):
    // watched get a reserved slice, held keep priority for the rest, and
    // anything dropped is logged and reported — never a silent cap.
    const plan = planBackfillRun(held, watchedMapped);
    if (plan.droppedHeld.length > 0 || plan.droppedWatched.length > 0) {
      const symbols = [...plan.droppedHeld, ...plan.droppedWatched].map((r) => r.symbol).join(', ');
      console.warn(
        `[cron/refresh-history] budget: dropped ${plan.droppedHeld.length} held, ${plan.droppedWatched.length} watched: ${symbols}`,
      );
    }

    let synced = 0;
    let bars = 0;

    for (const row of plan.take) {
      if (row.firstTradeDate === null) continue; // unreachable: grouped over transactions
      // The stored window matches the CHART's window (2026-08-20): the first
      // trade widened down to the same five-year floor the watched rows above
      // already use, so a recently-bought stock's chart has data behind it.
      // The watched rows already carry that floor as their `firstTradeDate`,
      // and widening it again is a no-op for them.
      bars += await backfillDailyHistory(
        { id: row.id, symbol: row.symbol, currency: row.currency },
        { from: instrumentAnchorDate(today, row.firstTradeDate), to: today },
      );
      synced++;
    }

    // Option close SELF-HEAL (2026-08-20), in its own try/catch immediately
    // before the recording leg below: a contract added after its first
    // recorded close would otherwise be forward-only forever and chart a few
    // days while every other contract charts three months (the one-off
    // backfill CLI was retired 2026-09-23; this leg is the only repair). Each
    // tracked ticker's stored minimum `as_of` is compared with the window it
    // SHOULD have; only the ones that fall short are backfilled, so the steady
    // state costs zero extra vendor calls. Best-effort: a failure here never
    // sinks the equity run above or the recording leg below.
    let optionBackfillTickers = 0;
    let optionBackfilledRows = 0;
    try {
      const lots = await db
        .select({ ticker: optionPositions.ticker, firstTradeDate: min(optionPositions.tradeDate) })
        .from(optionPositions)
        .groupBy(optionPositions.ticker);

      if (lots.length > 0) {
        // The stored floors come from `close-sync.ts` too: that module is the
        // only one that touches `option_daily_closes`, reads included.
        const tickers = lots.map((l) => l.ticker);
        const floors = await optionCloseFloors(tickers);
        // The ATTEMPT record, not the data floor: a thin contract whose
        // earliest real bar is later than the window's left edge would fail a
        // floor-only test forever and be re-fetched every night for nothing
        // (measured on a real far-dated contract: one bar in three months). A
        // backfilled row's `source` carries the date the walk STARTED from,
        // so the receipt can be compared with the window wanted now.
        const walked = await optionBackfilledWindows(tickers);

        const wanted: { ticker: string; fromISO: string }[] = [];
        for (const lot of lots) {
          if (lot.firstTradeDate === null) continue; // unreachable: grouped over lots
          const fromISO = optionBackfillFrom(today, lot.firstTradeDate);
          const walkedFrom = walked.get(lot.ticker);
          // Already walked from here or FURTHER BACK — nothing left to ask
          // for. A backdated lot imported later lowers `fromISO` below the
          // walked edge and re-walks: without that, the whole-book chart
          // would hole every day between the new lot's trade date and the old
          // floor, since a day one active lot cannot be priced is dropped.
          if (walkedFrom !== undefined && walkedFrom <= fromISO) continue;
          const stored = floors.get(lot.ticker);
          // Never walked. Skip only when the DATA already reaches the window
          // anyway (absent → never recorded → always backfill).
          if (walkedFrom === undefined && stored !== undefined && stored <= fromISO) continue;
          wanted.push({ ticker: lot.ticker, fromISO });
        }

        if (wanted.length > 0) {
          const filled = await backfillOptionDailyCloses(wanted);
          optionBackfillTickers = wanted.length;
          // Rows actually offered to the table, not tickers attempted: a
          // ticker with nothing new reports 0, and a night that stored
          // nothing must not look like a night that stored something. This
          // count is the only observability this leg has.
          for (const count of filled.values()) optionBackfilledRows += count;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'option close backfill failed';
      console.error(`[cron/refresh-history] option close backfill failed: ${message}`);
    }

    // Option daily-close recording (2026-08-15) rides this run DELIBERATELY —
    // no new cron slot; 23:30 UTC weekdays is after the US close, exactly
    // when the day's final option bar exists. Best-effort in its own
    // try/catch: a failure here never sinks the equity run above, and vice
    // versa (the equity loop already degrades per instrument). Holiday runs
    // self-correct — no session → no bar → no row — and the upsert is
    // idempotent by primary key.
    let optionContracts = 0;
    try {
      const optionRows = await db
        .selectDistinct({ ticker: optionPositions.ticker })
        .from(optionPositions);
      if (optionRows.length > 0) {
        const syncedBars = await syncOptionDailyCloses(
          optionRows.map((r) => r.ticker),
          { force: true },
        );
        optionContracts = syncedBars.size;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'option close sync failed';
      console.error(`[cron/refresh-history] option close sync failed: ${message}`);
    }

    // Option MODEL-MARK recording (2026-08-15) rides the same run, in its OWN
    // try/catch immediately after the close sync: neither sync can sink the
    // other, and no new cron slot or `vercel.json` entry exists. 23:30 UTC is
    // 19:30 ET — after the close, so the snapshot carries the session's final
    // IV and the official underlying close. If the vendor drops greeks
    // post-close (unverified on this tier), no row is written that night: an
    // honest hole, which this count makes visible.
    let optionMarks = 0;
    try {
      optionMarks = await recordOptionMarks();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'option mark sync failed';
      console.error(`[cron/refresh-history] option mark sync failed: ${message}`);
    }

    // Dividend top-up (2026-08-16) rides the same run — the options-leg
    // discipline verbatim: its own try/catch, best-effort, no new cron slot.
    // Cron has no session, so the single user row is selected directly (the
    // allowlist guarantees ≤ 1 forever); zero rows skip silently. A vendor
    // failure here never breaks the history refresh — `syncDividends` is
    // best-effort end to end and never throws — and edited/manual payment
    // rows survive by the store's overwrite-protection rule.
    let dividends = false;
    try {
      const [singleUser] = await db.select({ id: user.id }).from(user).limit(1);
      if (singleUser) {
        await syncDividends(singleUser.id);
        dividends = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'dividend sync failed';
      console.error(`[cron/refresh-history] dividend sync failed: ${message}`);
    }

    return Response.json(
      {
        ok: true,
        instruments: synced,
        bars,
        optionContracts,
        // Attempted vs stored, kept apart deliberately: `backfillOptionDailyCloses`
        // records a 0 for a ticker it found nothing new for, so a ticker count
        // alone cannot tell a quiet night from a productive one.
        optionBackfillTickers,
        optionBackfilledRows,
        optionMarks,
        dividends,
        dropped: { held: plan.droppedHeld.length, watched: plan.droppedWatched.length },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[cron/refresh-history]', error);
    return Response.json({ error: 'Refresh failed.' }, { status: 502, headers: NO_STORE });
  }
}
