import type Decimal from 'decimal.js';

import { dec, ZERO } from '@/lib/money';

/**
 * Pure position engine — the arithmetic heart of the app.
 *
 * Deliberately a plain module with no server marker and no imports beyond
 * decimal.js (via money.ts): it reads neither env nor the database, which is
 * what keeps it unit-testable in a node Vitest environment. It is only ever
 * *called* from Server Components / Server Actions that did the fetching.
 *
 * Every arithmetic operation happens on Decimal. A JS number never touches a
 * quantity, price, fee or FX rate in here.
 */

/**
 * Structural input type — a transaction row joined with its instrument fits
 * this shape directly, no mapping layer needed.
 */
export interface EngineTransaction {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  /** Instrument trading currency, e.g. 'PLN', 'USD'. */
  currency: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  fees: string;
  /** Rate to PLN frozen at entry; exactly '1' for PLN instruments. */
  fxRateToBase: string;
  /** Plain 'YYYY-MM-DD' — never round-tripped through Date. */
  tradeDate: string;
  createdAt: Date;
}

/** Latest quote for an instrument, keyed by symbol in the quotes map (M3+). */
export interface QuoteInput {
  /** Per share, in the instrument's trading currency. */
  price: string;
  currency: string;
}

export interface Position {
  instrumentId: string;
  symbol: string;
  displayName: string;
  currency: string;
  quantity: Decimal;
  /** Average cost per share in the trading currency; null when quantity is 0. */
  avgCost: Decimal | null;
  /** Open cost basis in the trading currency (fees included, §9 Q5). */
  costBasis: Decimal;
  /** Open cost basis in PLN at the stored trade-date rates. */
  costBasisPLN: Decimal;
  /** Realized P/L in PLN across all closed quantity, average-cost method. */
  realizedPLN: Decimal;
  /** A sell exceeded the held quantity — flagged, never rejected (§9 Q4). */
  oversold: boolean;
  /** quantity x quote price in the trading currency; null without a quote. */
  marketValue: Decimal | null;
  /** marketValue in PLN minus costBasisPLN; null without a quote + FX rate. */
  unrealizedPLN: Decimal | null;
}

/**
 * Aggregate transactions into per-instrument positions using average cost
 * (a standing decision: lots stay in the DB for a future FIFO view).
 *
 * Ordering is resolved *inside* the engine — tradeDate asc, then createdAt
 * asc, then id — because average cost with interleaved sells is
 * order-dependent and callers must not be trusted to pre-sort.
 *
 * Closed positions (quantity 0) are returned too: they carry realizedPLN.
 * Callers filter for display.
 *
 * `quotes` (keyed by symbol) and `fxRates` (currency -> rate to PLN) are the
 * M3 hooks; omitted in M2, leaving marketValue / unrealizedPLN null.
 */
export function computePositions(
  txs: EngineTransaction[],
  quotes?: ReadonlyMap<string, QuoteInput>,
  fxRates?: ReadonlyMap<string, string>,
): Position[] {
  const groups = new Map<string, EngineTransaction[]>();
  for (const t of txs) {
    const group = groups.get(t.instrumentId);
    if (group) {
      group.push(t);
    } else {
      groups.set(t.instrumentId, [t]);
    }
  }

  const positions: Position[] = [];

  for (const group of groups.values()) {
    const sorted = [...group].sort(compareTx);
    const { instrumentId, symbol, displayName, currency } = sorted[0];

    let qty = ZERO;
    let costBasis = ZERO;
    let costBasisPLN = ZERO;
    let realizedPLN = ZERO;
    let oversold = false;

    for (const t of sorted) {
      const q = dec(t.quantity);
      const price = dec(t.price);
      const fees = dec(t.fees);
      const fx = dec(t.fxRateToBase);

      if (t.side === 'buy') {
        const cost = q.times(price).plus(fees);
        qty = qty.plus(q);
        costBasis = costBasis.plus(cost);
        costBasisPLN = costBasisPLN.plus(cost.times(fx));
      } else {
        // Manual entry may arrive out of order: an oversell is flagged and
        // clamped to the held quantity, never thrown (§9 Q4).
        const sellable = q.greaterThan(qty) ? qty : q;
        if (q.greaterThan(qty)) oversold = true;

        // Fees reduce proceeds in full, even when the sale is clamped.
        const proceedsPLN = sellable.times(price).minus(fees).times(fx);

        if (qty.greaterThan(0)) {
          const avgCost = costBasis.dividedBy(qty);
          const avgCostPLN = costBasisPLN.dividedBy(qty);
          realizedPLN = realizedPLN.plus(proceedsPLN.minus(avgCostPLN.times(sellable)));
          costBasis = costBasis.minus(avgCost.times(sellable));
          costBasisPLN = costBasisPLN.minus(avgCostPLN.times(sellable));
          qty = qty.minus(sellable);
        } else {
          // Nothing held: no quantity to realize against, but the fee is paid.
          realizedPLN = realizedPLN.plus(proceedsPLN);
        }

        if (qty.isZero()) {
          // A full exit zeroes the basis exactly. Proportional subtraction can
          // leave division dust (1e-30-ish); assigning ZERO kills it so a later
          // buy starts a genuinely fresh average.
          costBasis = ZERO;
          costBasisPLN = ZERO;
        }
      }
    }

    const quote = quotes?.get(symbol);
    let marketValue: Decimal | null = null;
    let unrealizedPLN: Decimal | null = null;
    // A quote in a different currency than the instrument trades in would be
    // multiplied by the wrong FX rate — treat it as no quote at all.
    if (quote && quote.currency === currency && qty.greaterThan(0)) {
      marketValue = qty.times(dec(quote.price));
      const rate = currency === 'PLN' ? '1' : fxRates?.get(currency);
      if (rate !== undefined) {
        unrealizedPLN = marketValue.times(dec(rate)).minus(costBasisPLN);
      }
    }

    positions.push({
      instrumentId,
      symbol,
      displayName,
      currency,
      quantity: qty,
      avgCost: qty.isZero() ? null : costBasis.dividedBy(qty),
      costBasis,
      costBasisPLN,
      realizedPLN,
      oversold,
      marketValue,
      unrealizedPLN,
    });
  }

  // Deterministic display order regardless of input order.
  positions.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return positions;
}

/**
 * Display filter for Holdings: open positions, plus zero-quantity positions
 * flagged oversold — the flag exists precisely for the sell-entered-before-
 * its-buy mistake, which clamps quantity to zero (§9 Q4). Hiding those rows
 * would make the warning unreachable in the one case it was built for.
 * Cleanly closed positions stay hidden.
 */
export function displayablePositions(positions: Position[]): Position[] {
  return positions.filter((p) => p.quantity.greaterThan(0) || p.oversold);
}

/**
 * Quantity held at the END of the day BEFORE `dateISO` — the dividend
 * eligibility question (2026-08-16, dividends plan): a payment belongs to
 * whoever held shares the day before the ex-date. The boundary is STRICT
 * `tradeDate < dateISO` ('YYYY-MM-DD' compares lexically): a buy ON the
 * ex-date does not earn the dividend, and an off-by-one here pays dividends
 * on shares bought too late — the boundary case is a named unit test.
 *
 * A pure sibling of `computePositions`, sharing `compareTx` ordering and the
 * SAME sell-clamp semantics (an oversell reduces to zero held, never
 * negative). Callers pass one instrument's rows for one portfolio; mixed
 * instruments would sum share counts of different companies.
 */
export function quantityHeldBefore(txs: EngineTransaction[], dateISO: string): Decimal {
  const sorted = txs.filter((t) => t.tradeDate < dateISO).sort(compareTx);

  let qty = ZERO;
  for (const t of sorted) {
    const q = dec(t.quantity);
    if (t.side === 'buy') {
      qty = qty.plus(q);
    } else {
      // The engine's clamp, verbatim in effect: a sell never takes the held
      // quantity below zero (§9 Q4 — out-of-order manual entry is flagged
      // elsewhere, not thrown).
      qty = qty.minus(q.greaterThan(qty) ? qty : q);
    }
  }
  return qty;
}

/** tradeDate asc ('YYYY-MM-DD' compares lexically), createdAt asc, id asc. */
function compareTx(a: EngineTransaction, b: EngineTransaction): number {
  if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
