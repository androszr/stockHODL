import { ZERO, dec } from '@/lib/money';

import type { OptionPositionRow } from './options-payload';

/**
 * Lot aggregation for the options surfaces — pure and isomorphic (no
 * `server-only`, no DB, no fetch, no formatting): rows in, one entry per
 * CONTRACT out.
 *
 * Two purchases of the very same OCC contract are one position, so they get
 * one card: combined size, the quantity-WEIGHTED average entry price, summed
 * costs. Different strikes, expiries or underlyings never merge — those are
 * genuinely different positions and a merged break-even would be meaningless.
 * The group key is the EXACT `ticker` and nothing looser; `underlying`,
 * `contractType`, `strikePrice` and `expirationDate` are all encoded in the
 * OCC ticker, so members agree on them by construction.
 *
 * Every figure here is a decimal string through `dec()`: no parsing back into
 * a JS number, no float coercion of any kind, nothing in this file that a
 * money value passes through except decimal.js. The average is emitted at
 * FULL precision via `.toString()` — deliberately NOT through money.ts's
 * numeric serializer, whose 8-dp `toFixed` would round the average before
 * break-even and P/L derive from it. This module rounds nothing;
 * `composeOptionsPayload` formats once, at the end.
 */

/** One card's worth of lots — a contract, not a row. */
export interface AggregatedOptionLots {
  /**
   * Stable card identity: the OCC ticker, or `${ticker}#${row.id}` for a
   * degenerate group that refuses to merge (below). Unique per card, which is
   * what lets it serve as the sort's final tiebreak.
   */
  key: string;
  ticker: string;
  underlying: string;
  contractType: 'call' | 'put';
  strikePrice: string;
  /** 'YYYY-MM-DD'. */
  expirationDate: string;
  sharesPerContract: string;
  /** Σ quantity, decimal string. */
  quantity: string;
  /** Σ(entry × qty) / Σ(qty), decimal string, FULL precision. */
  entryPrice: string;
  /** Σ fees, decimal string. */
  fees: string;
  /**
   * The EARLIEST member trade date — the position's age.
   *
   * Nothing renders it: the card deliberately dropped `tradeDate` so an
   * averaged lot can never prefill an edit form (that is a compile error now).
   * Kept because it is the one honest answer to "since when have I held this",
   * and `lots` already carries every member's own date for the edit menu — but
   * treat it as informational. Deriving money from it would be reading one
   * member's date as the whole position's.
   */
  tradeDate: string;
  /** Members, oldest tradeDate first then row id. Always length ≥ 1. */
  lots: readonly OptionPositionRow[];
}

/**
 * A single-lot group passes the STORED strings through verbatim — no
 * round-trip through `.times(q).dividedBy(q)`, which is a needless chance to
 * change a stored figure. Today's single-lot cards must stay byte-identical.
 */
function single(row: OptionPositionRow, key: string): AggregatedOptionLots {
  return {
    key,
    ticker: row.ticker,
    underlying: row.underlying,
    contractType: row.contractType,
    strikePrice: row.strikePrice,
    expirationDate: row.expirationDate,
    sharesPerContract: row.sharesPerContract,
    quantity: row.quantity,
    entryPrice: row.entryPrice,
    fees: row.fees,
    tradeDate: row.tradeDate,
    lots: [row],
  };
}

/** Oldest trade date first; the row id settles a same-day tie, so the order
 *  is total and the `⋯` menu cannot reshuffle under the 60 s poll. */
function byAge(a: OptionPositionRow, b: OptionPositionRow): number {
  if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Rows → one aggregate per contract, in FIRST-APPEARANCE order of the input
 * (the loader's `createdAt` ordering), so the function is deterministic and
 * the sort's tiebreak has something stable to rest on.
 */
export function aggregateOptionLots(
  rows: readonly OptionPositionRow[],
): AggregatedOptionLots[] {
  const groups = new Map<string, OptionPositionRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.ticker);
    if (existing) existing.push(row);
    else groups.set(row.ticker, [row]);
  }

  const out: AggregatedOptionLots[] = [];
  for (const [ticker, members] of groups) {
    if (members.length === 1) {
      out.push(single(members[0], ticker));
      continue;
    }

    const lots = [...members].sort(byAge);

    let quantitySum = ZERO;
    let weightedEntry = ZERO;
    let feeSum = ZERO;
    for (const lot of lots) {
      const q = dec(lot.quantity);
      quantitySum = quantitySum.plus(q);
      // The WEIGHTED numerator: Σ(entry × qty). A plain mean of the prices
      // would be a different (wrong) number whenever the lot sizes differ,
      // and the break-even printed on the card derives from this.
      weightedEntry = weightedEntry.plus(dec(lot.entryPrice).times(q));
      feeSum = feeSum.plus(dec(lot.fees));
    }

    // Degenerate groups do NOT merge. A zero Σ(quantity) would divide by zero
    // and carry `Infinity`/`NaN` straight into a money string, and members
    // disagreeing on `sharesPerContract` have no shared multiplier at all.
    // Validation already forbids a non-positive quantity, so this is defence
    // in depth — but it is the difference between "no aggregation" and a NaN
    // break-even.
    // Every field taken "from the first member" is guarded, not just the
    // multiplier. The OCC ticker encodes underlying, type, strike and expiry,
    // so members SHOULD agree by construction — but nothing in the write path
    // enforces that: `optionPositionAddSchema` validates each field
    // independently of the ticker, and `addOptionPosition` inserts them
    // verbatim. Guarding only `sharesPerContract` while printing the first
    // member's strike and deriving BREAK-EVEN from it — and letting its expiry
    // decide whether the card hides behind the expired toggle — was the
    // inconsistency (bug audit, 2026-08-15). Strike compares by Decimal
    // equality: '370' and '370.00' are one strike, not a mismatch.
    const first0 = lots[0];
    const membersDisagree = lots.some(
      (lot) =>
        !dec(lot.sharesPerContract).equals(dec(first0.sharesPerContract)) ||
        !dec(lot.strikePrice).equals(dec(first0.strikePrice)) ||
        lot.expirationDate !== first0.expirationDate ||
        lot.contractType !== first0.contractType ||
        lot.underlying !== first0.underlying,
    );
    if (quantitySum.isZero() || membersDisagree) {
      for (const lot of lots) out.push(single(lot, `${ticker}#${lot.id}`));
      continue;
    }

    const first = lots[0];
    out.push({
      key: ticker,
      ticker,
      underlying: first.underlying,
      contractType: first.contractType,
      strikePrice: first.strikePrice,
      expirationDate: first.expirationDate,
      sharesPerContract: first.sharesPerContract,
      quantity: quantitySum.toString(),
      // Σ(entry × qty) / Σ(qty) — exact to the configured 34 significant
      // digits, which is far below a cent on any real lot and the only
      // rounding that happens before display.
      entryPrice: weightedEntry.dividedBy(quantitySum).toString(),
      fees: feeSum.toString(),
      // Lexicographic minimum of the ISO dates — `lots` is already oldest-first.
      tradeDate: first.tradeDate,
      lots,
    });
  }

  return out;
}
