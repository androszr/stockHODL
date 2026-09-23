import 'server-only';

import { eq } from 'drizzle-orm';

import { db, instruments, portfolios, transactions } from '@/lib/db';
import { getFxRateToPln, type FxRateResult } from '@/lib/fx/nbp';
import { massiveProvider } from '@/lib/market-data/massive';
import type { DividendEvent } from '@/lib/market-data/provider';
import { dec } from '@/lib/money';
import { quantityHeldBefore, type EngineTransaction } from '@/lib/position-engine';

import { upsertFetchedPayments, type FetchedPaymentInput } from './store';
import { isFxSupported } from './summary';

/**
 * The dividends auto-fetch: for every company the user has ever traded, ask
 * the provider for its dividend history since the first recorded trade, then
 * reconstruct from the ledger how many shares each portfolio held the day
 * before each qualifying date (`quantityHeldBefore` — strict `tradeDate <
 * exDate`). A payment row exists only where shares were actually held then;
 * bought-after-the-qualifying-day is correctly not paid.
 *
 * Best-effort END TO END: `syncDividends` never throws into a caller — a
 * vendor 429 on dividends must not break the nightly history refresh, and a
 * failed instrument never sinks the others. Sequential per instrument
 * (dividends are ~4 rows/yr/name; fan-out is bounded by portfolio size and
 * the provider discipline forbids `Promise.all` anyway).
 *
 * All writes go through `store.upsertFetchedPayments`, where the
 * overwrite-protection rule lives — this module never decides what may be
 * overwritten.
 */

/**
 * The DEFAULT withholding applied when a payment row is first created — the
 * 15% American treaty rate. A default PER ROW, not a law baked into the app:
 * it is stored on each payment, the user edits it freely, and net is always
 * derived from the STORED gross/withheld columns — never from this constant
 * at render time.
 */
export const DEFAULT_WITHHOLDING_RATE = '0.15';

/** One joined ledger row — the engine shape plus its portfolio. */
export type DividendSyncRow = EngineTransaction & { portfolioId: string };

/** The injectable IO seams, so the decision logic tests hermetically. */
export interface DividendSyncDeps {
  loadRows(userId: string): Promise<DividendSyncRow[]>;
  getDividends(symbol: string, sinceExDateISO: string): Promise<DividendEvent[]>;
  getFxRate(input: { currency: string; tradeDate: string }): Promise<FxRateResult>;
  upsert(rows: FetchedPaymentInput[]): Promise<void>;
  /** "Today" as a Warsaw-calendar 'YYYY-MM-DD' — a date, not money. */
  todayISO(): string;
}

/**
 * Frozen FX for one payment: the D-1 NBP rate at the payment date
 * (`payDate ?? exDate` — the date the money actually arrived). PLN
 * short-circuits to '1'; an unknown currency or any lookup miss
 * (`no_rate`/`not_published`/`unavailable`) yields NULL — the row's rate
 * column stays empty, the UI shows an honest dash, and the NEXT sync retries
 * (null is never persisted as an answer, only as an absence).
 */
async function resolveFxRate(
  deps: DividendSyncDeps,
  cache: Map<string, string | null>,
  currency: string,
  dateISO: string,
): Promise<string | null> {
  if (currency === 'PLN') return '1';
  // The closed allowlist BEFORE anything reaches the NBP path — the same
  // contract every other getFxRateToPln caller honours. The SHARED predicate
  // (`isFxSupported` in summary.ts): the summaries disclose this exact state
  // as "no PLN rate" rather than "awaiting", so the check and the copy can
  // never drift apart.
  if (!isFxSupported(currency)) return null;

  const key = `${currency}|${dateISO}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let rate: string | null = null;
  try {
    const result = await deps.getFxRate({ currency, tradeDate: dateISO });
    if (result.ok) rate = result.rate;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fx lookup failed';
    console.error(`Dividend FX lookup failed (${currency} ${dateISO}): ${message}`);
  }
  cache.set(key, rate);
  return rate;
}

/**
 * The sync over injected IO. Returns the number of payment rows handed to
 * the store. Per-instrument failures degrade and continue; only a failure of
 * the initial ledger read propagates (the wrapper catches it).
 */
export async function syncDividendsWith(
  deps: DividendSyncDeps,
  userId: string,
): Promise<number> {
  const rows = await deps.loadRows(userId);
  if (rows.length === 0) return 0;

  const today = deps.todayISO();

  const byInstrument = new Map<string, DividendSyncRow[]>();
  for (const row of rows) {
    const group = byInstrument.get(row.instrumentId);
    if (group) group.push(row);
    else byInstrument.set(row.instrumentId, [row]);
  }

  const fxCache = new Map<string, string | null>();
  let total = 0;

  // Sequential, deliberately — one user, no vendor fan-out.
  for (const [instrumentId, instrumentTxs] of byInstrument) {
    const symbol = instrumentTxs[0].symbol;
    // Earliest recorded trade bounds the history window: no dividend before
    // the first buy can ever be eligible (zero held before it).
    const earliestTradeDate = instrumentTxs.map((t) => t.tradeDate).sort()[0];

    try {
      const events = await deps.getDividends(symbol, earliestTradeDate);
      if (events.length === 0) continue;

      const byPortfolio = new Map<string, DividendSyncRow[]>();
      for (const tx of instrumentTxs) {
        const group = byPortfolio.get(tx.portfolioId);
        if (group) group.push(tx);
        else byPortfolio.set(tx.portfolioId, [tx]);
      }

      const payments: FetchedPaymentInput[] = [];
      for (const event of events) {
        // Not yet paid → not yet a record. The Warsaw calendar decides
        // "today"; the next sync after the pay date picks it up.
        const effectiveDate = event.payDate ?? event.exDate;
        if (effectiveDate > today) continue;

        for (const [portfolioId, portfolioTxs] of byPortfolio) {
          const qty = quantityHeldBefore(portfolioTxs, event.exDate);
          // Bought after the qualifying day, or opened mid-period: correctly
          // not paid — no row at all, never a zero row.
          if (!qty.greaterThan(0)) continue;

          const gross = qty.times(dec(event.cashAmount));
          const withheld = gross.times(dec(DEFAULT_WITHHOLDING_RATE));
          const fxRateToBase = await resolveFxRate(deps, fxCache, event.currency, effectiveDate);

          payments.push({
            portfolioId,
            instrumentId,
            vendorEventId: event.vendorId,
            exDate: event.exDate,
            payDate: event.payDate,
            quantity: qty.toString(),
            amountPerShare: event.cashAmount,
            grossAmount: gross.toString(),
            withheldTax: withheld.toString(),
            currency: event.currency,
            fxRateToBase,
          });
        }
      }

      if (payments.length > 0) await deps.upsert(payments);
      total += payments.length;
    } catch (error) {
      // One failing instrument never sinks the rest — the backfill discipline.
      const message = error instanceof Error ? error.message : 'dividend sync failed';
      console.error(`Dividend sync failed (${symbol}): ${message}`);
    }
  }

  return total;
}

/* ------------------------------------------------------------------ *
 * The real wiring.
 * ------------------------------------------------------------------ */

/** In-process last-run instant — the /dividends first-visit trigger's memo.
 *  Per-instance, evaporates on cold start; fine at exactly one user. */
let lastSyncAtMs: number | null = null;

const SYNC_FRESH_MS = 6 * 60 * 60 * 1000;

/** Whether a sync completed recently on THIS instance (best-effort memo). */
export function dividendsSyncFresh(nowMs: number = Date.now()): boolean {
  return lastSyncAtMs !== null && nowMs - lastSyncAtMs < SYNC_FRESH_MS;
}

/** The user's full joined ledger — the `loadHoldingsInputs` join shape. */
async function loadLedgerRows(userId: string): Promise<DividendSyncRow[]> {
  const raw = await db
    .select({
      id: transactions.id,
      instrumentId: transactions.instrumentId,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
      side: transactions.side,
      quantity: transactions.quantity,
      price: transactions.price,
      fees: transactions.fees,
      fxRateToBase: transactions.fxRateToBase,
      tradeDate: transactions.tradeDate,
      createdAt: transactions.createdAt,
      portfolioId: transactions.portfolioId,
    })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(portfolios.userId, userId));

  // `side` checked, never cast wholesale — the column type is text.
  return raw.map((r) => ({ ...r, side: r.side === 'sell' ? 'sell' : 'buy' }));
}

/** Warsaw-calendar 'YYYY-MM-DD' — a date string, not money (the nbp.ts idiom). */
function todayWarsawISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

/**
 * Top up the user's dividend payments from the vendor. Best-effort end to
 * end — never throws into a caller (the cron leg and the page's first-visit
 * fill both depend on that).
 */
export async function syncDividends(userId: string): Promise<void> {
  try {
    await syncDividendsWith(
      {
        loadRows: loadLedgerRows,
        getDividends: (symbol, since) => massiveProvider.getDividends(symbol, since),
        getFxRate: getFxRateToPln,
        upsert: upsertFetchedPayments,
        todayISO: todayWarsawISO,
      },
      userId,
    );
    lastSyncAtMs = Date.now();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'dividend sync failed';
    console.error(`Dividend sync failed: ${message}`);
  }
}
