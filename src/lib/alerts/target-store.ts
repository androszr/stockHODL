import 'server-only';

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type {
  PriceTargetContract,
  TargetStatusContract,
} from '@/lib/api/contracts/price-targets';
import { db, instruments, portfolios, priceTargets, transactions, watchlist } from '@/lib/db';
import { fetchQuotesBestEffort } from '@/lib/holdings/live-view';
import { dec, toNumeric } from '@/lib/money';

import type { AlertDirection } from './dedupe';
import { targetStatusFor, type TargetLine } from './target-proximity';

/**
 * Price-target reads and writes (plans/2026-09-05-price-target-alerts.md).
 * Same discipline as `watchlist/mutations.ts`: the user id is an argument the
 * caller derived from a session, and every row written or deleted is scoped
 * to it. The cron reads through `loadPendingTargets`/`markTargetHit` only.
 */

export type CreateTargetRefusal =
  /** Neither held (net-positive quantity) nor watched — the route's 409. */
  | 'not_followed'
  /** Massive is US-only; a target on a non-USD instrument could never be
   *  checked, so refusing is honest (no-second-vendor decision). 409. */
  | 'unsupported_currency'
  /** Target equals the current price — no direction to cross from. 400. */
  | 'equal_price'
  /** No live price and no cached one — cannot place a target blind. 503. */
  | 'no_price';

export type CreateTargetResult =
  | {
      ok: true;
      targets: PriceTargetContract[];
      /** The recomputed proximity readout, from the price this create just
       *  fetched — the mutation response carries it so the screen's sentence
       *  updates without a detail refetch. */
      status: TargetStatusContract | null;
    }
  | { ok: false; reason: CreateTargetRefusal; error: string };

/** What `deleteTarget` answers — the fresh list plus the recomputed status
 *  (both empty/null when the idempotent no-op deleted nothing). */
export interface DeleteTargetResult {
  targets: PriceTargetContract[];
  status: TargetStatusContract | null;
}

/** A pending target joined to its instrument, as the cron evaluates it. */
export interface PendingTarget {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  currency: string;
  /** Decimal string, `numeric` verbatim — compared via `dec()` only. */
  targetPrice: string;
  direction: AlertDirection;
  createdAt: Date;
}

/** A stored row → the contract shape. `dec()` re-normalisation so
 *  numeric(20,8) padding never leaks ('190.00000000' → '190'). */
function toContract(row: {
  id: string;
  instrumentId: string;
  targetPrice: string;
  direction: string;
  hitAt: Date | null;
  createdAt: Date;
}): PriceTargetContract {
  return {
    id: row.id,
    instrumentId: row.instrumentId,
    targetPrice: dec(row.targetPrice).toString(),
    // The column is text; checked per row, never cast wholesale — the `side`
    // convention.
    direction: row.direction === 'down' ? 'down' : 'up',
    hitAtMs: row.hitAt?.getTime() ?? null,
    createdAtMs: row.createdAt.getTime(),
  };
}

/** This user's targets on one instrument, oldest first — the screen's list
 *  and both mutation responses. */
export async function listTargets(
  userId: string,
  instrumentId: string,
): Promise<PriceTargetContract[]> {
  const rows = await db
    .select({
      id: priceTargets.id,
      instrumentId: priceTargets.instrumentId,
      targetPrice: priceTargets.targetPrice,
      direction: priceTargets.direction,
      hitAt: priceTargets.hitAt,
      createdAt: priceTargets.createdAt,
    })
    .from(priceTargets)
    .where(and(eq(priceTargets.userId, userId), eq(priceTargets.instrumentId, instrumentId)))
    .orderBy(asc(priceTargets.createdAt));
  return rows.map(toContract);
}

/**
 * Create one target line. Refused unless the user holds the instrument
 * (net-positive quantity — the `followed-instruments.ts` HAVING shape) or
 * watches it, and refused for non-USD instruments. The direction is derived
 * from the current price HERE and persisted, so the cron check never depends
 * on the price at check time — a target the stock gaps past must still fire
 * as the direction it was set in.
 */
export async function createTarget(
  userId: string,
  instrumentId: string,
  targetPrice: string,
): Promise<CreateTargetResult> {
  const instrument = await followedOrWatchedInstrument(userId, instrumentId);
  if (!instrument) {
    return {
      ok: false,
      reason: 'not_followed',
      error: 'Targets can be set on stocks you hold or watch.',
    };
  }
  if (instrument.currency !== 'USD') {
    return {
      ok: false,
      reason: 'unsupported_currency',
      error: 'Targets are only available for USD-listed stocks.',
    };
  }

  // Live price first, the durable cached row second — the single ref opts
  // this symbol into the cache's transient-failure fallback read.
  const { quotes, cached } = await fetchQuotesBestEffort(
    [instrument.symbol],
    new Map([[instrument.symbol, instrumentId]]),
  );
  // Same currency guard as the composer and `deleteTarget`: a quote in the
  // wrong currency is no price, so the status this create answers can never
  // state a distance the watchlist tile would dash out as unpriced.
  const quote = quotes.get(instrument.symbol);
  const cachedQuote = cached.get(instrument.symbol);
  const current =
    quote && quote.currency === instrument.currency
      ? quote.price
      : cachedQuote && cachedQuote.currency === instrument.currency
        ? cachedQuote.price
        : undefined;
  if (current === undefined) {
    return {
      ok: false,
      reason: 'no_price',
      error: 'No current price is available right now — try again in a moment.',
    };
  }

  const target = dec(targetPrice);
  const currentDec = dec(current);
  if (target.eq(currentDec)) {
    return {
      ok: false,
      reason: 'equal_price',
      error: 'That is the current price — set the target above or below it.',
    };
  }
  const direction: AlertDirection = target.gt(currentDec) ? 'up' : 'down';

  await db.insert(priceTargets).values({
    userId,
    instrumentId,
    targetPrice: toNumeric(target),
    direction,
  });

  const targets = await listTargets(userId, instrumentId);
  return {
    ok: true,
    targets,
    // Reuses the price this create already fetched — no second vendor call.
    // `PriceTargetContract` satisfies `TargetLine` structurally.
    status: targetStatusFor(targets, currentDec.toString(), instrument.currency),
  };
}

/**
 * Delete one target, ownership in the WHERE clause. Idempotent by decision —
 * an absent or foreign id deletes nothing and still answers ok (the
 * watchlist-delete precedent; nothing here is enumerable). Returns the
 * affected instrument's fresh list plus the recomputed proximity status
 * (one quote fetch, cached fallback); when nothing was deleted the
 * instrument is unknowable, the list is empty and the status null.
 */
export async function deleteTarget(userId: string, id: string): Promise<DeleteTargetResult> {
  const deleted = await db
    .delete(priceTargets)
    .where(and(eq(priceTargets.userId, userId), eq(priceTargets.id, id)))
    .returning({ instrumentId: priceTargets.instrumentId });

  const instrumentId = deleted[0]?.instrumentId;
  if (instrumentId === undefined) return { targets: [], status: null };

  const [targets, [instrument]] = await Promise.all([
    listTargets(userId, instrumentId),
    db
      .select({ symbol: instruments.symbol, currency: instruments.currency })
      .from(instruments)
      .where(eq(instruments.id, instrumentId))
      .limit(1),
  ]);
  if (!instrument) return { targets, status: null };

  // One best-effort quote (the single ref opts it into the durable cache's
  // fallback read) — the status the screen adopts must measure from the same
  // kind of price the tiles do, currency guard included.
  const { quotes, cached } = await fetchQuotesBestEffort(
    [instrument.symbol],
    new Map([[instrument.symbol, instrumentId]]),
  );
  const quote = quotes.get(instrument.symbol);
  const cachedQuote = cached.get(instrument.symbol);
  const current =
    quote && quote.currency === instrument.currency
      ? quote.price
      : cachedQuote && cachedQuote.currency === instrument.currency
        ? cachedQuote.price
        : null;

  return { targets, status: targetStatusFor(targets, current, instrument.currency) };
}

/**
 * EVERY target line of one user, grouped by instrument — pending AND hit
 * (hit rows feed the `hitOnly` flag), oldest first within a group. One query;
 * the watchlist composer joins the result to its items by instrument id.
 */
export async function loadTargetLinesByInstrument(
  userId: string,
): Promise<Map<string, TargetLine[]>> {
  const rows = await db
    .select({
      instrumentId: priceTargets.instrumentId,
      targetPrice: priceTargets.targetPrice,
      hitAt: priceTargets.hitAt,
      createdAt: priceTargets.createdAt,
    })
    .from(priceTargets)
    .where(eq(priceTargets.userId, userId))
    .orderBy(asc(priceTargets.createdAt));

  const byInstrument = new Map<string, TargetLine[]>();
  for (const row of rows) {
    const lines = byInstrument.get(row.instrumentId) ?? [];
    lines.push({
      // `dec()` re-normalisation, the `toContract` rule: numeric(20,8)
      // padding never leaks.
      targetPrice: dec(row.targetPrice).toString(),
      hitAtMs: row.hitAt?.getTime() ?? null,
      createdAtMs: row.createdAt.getTime(),
    });
    byInstrument.set(row.instrumentId, lines);
  }
  return byInstrument;
}

/**
 * Every pending (`hit_at IS NULL`) target of one user, joined to its
 * instrument — the cron's evaluation set. Deliberately NOT filtered on
 * held/watched: a target is an explicit standing order until the user
 * deletes it, even on a stock since sold or unwatched.
 */
export async function loadPendingTargets(userId: string): Promise<PendingTarget[]> {
  const rows = await db
    .select({
      id: priceTargets.id,
      instrumentId: priceTargets.instrumentId,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
      targetPrice: priceTargets.targetPrice,
      direction: priceTargets.direction,
      createdAt: priceTargets.createdAt,
    })
    .from(priceTargets)
    .innerJoin(instruments, eq(priceTargets.instrumentId, instruments.id))
    .where(and(eq(priceTargets.userId, userId), isNull(priceTargets.hitAt)))
    .orderBy(asc(priceTargets.createdAt));

  return rows.map((r) => ({
    ...r,
    targetPrice: dec(r.targetPrice).toString(),
    direction: r.direction === 'down' ? 'down' : ('up' as const),
  }));
}

/** Persist a hit — only ever called AFTER a delivered push (the
 *  delivery-before-commit rule). `hit_at IS NULL` in the WHERE keeps the
 *  first delivery's instant even if a second run raced this one. */
export async function markTargetHit(id: string, at: Date): Promise<void> {
  await db
    .update(priceTargets)
    .set({ hitAt: at })
    .where(and(eq(priceTargets.id, id), isNull(priceTargets.hitAt)));
}

/**
 * The instrument's identity, iff this user holds it (net-positive quantity —
 * the `followed-instruments.ts` HAVING clause shape, summed in Postgres
 * `numeric`, never in JS) or watches it. One instrument by id, so the two
 * checks run as two cheap scoped queries.
 */
async function followedOrWatchedInstrument(
  userId: string,
  instrumentId: string,
): Promise<{ symbol: string; currency: string } | undefined> {
  const [held] = await db
    .select({ symbol: instruments.symbol, currency: instruments.currency })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(and(eq(portfolios.userId, userId), eq(instruments.id, instrumentId)))
    .groupBy(instruments.id, instruments.symbol, instruments.currency)
    .having(
      sql`sum(case when ${transactions.side} = 'buy' then ${transactions.quantity} else -${transactions.quantity} end) > 0`,
    );
  if (held) return held;

  const [watched] = await db
    .select({ symbol: instruments.symbol, currency: instruments.currency })
    .from(watchlist)
    .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id))
    .where(and(eq(watchlist.userId, userId), eq(watchlist.instrumentId, instrumentId)))
    .limit(1);
  return watched;
}
