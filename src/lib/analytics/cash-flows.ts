import type Decimal from 'decimal.js';

import { dec, ZERO } from '@/lib/money';
import type { EngineTransaction } from '@/lib/position-engine';

import type { CashFlow } from './xirr';

/**
 * `EngineTransaction[]` → dated PLN cash flows, from the INVESTOR's
 * perspective. Pure and isomorphic — no server marker, no DB, no env, the
 * position-engine precedent — so this stays unit-testable under the node
 * Vitest environment. (The marker is not spelled out here: an acceptance
 * criterion greps the pure layer for it.)
 *
 * Two rules that are easy to get wrong and are both pinned by tests:
 *
 * - **Fees are inside the basis** (a standing decision of the MVP), so a buy costs
 *   `gross + fees` and a sell nets `gross - fees`.
 * - **The FX rate is the FROZEN trade-date rate** (`fxRateToBase`), never
 *   today's. A historical cash flow revalued at a current rate would make the
 *   return move every time the złoty does, which is precisely the thing a
 *   money-weighted return must not do. PLN rows carry '1' by construction.
 *
 * Sign convention: NEGATIVE for buys (money leaves you), POSITIVE for sells.
 */

export interface CashFlowOptions {
  /**
   * Instruments to drop ENTIRELY — every transaction of theirs, both sides.
   *
   * This is the load-bearing correctness filter of the whole feature: an open
   * position the summary could not price contributes buys but no terminal
   * value, and feeding that into XIRR reports a catastrophic loss on a
   * holding that is merely unpriced. A position that is fully CLOSED needs no
   * price and must stay in — its flows are complete on both sides — so the
   * predicate the caller applies is "open AND unpriceable", never
   * "unpriceable".
   */
  excludeInstrumentIds?: ReadonlySet<string>;
}

export function buildCashFlows(
  txs: readonly EngineTransaction[],
  opts?: CashFlowOptions,
): CashFlow[] {
  const excluded = opts?.excludeInstrumentIds;
  const flows: CashFlow[] = [];

  for (const tx of txs) {
    if (excluded?.has(tx.instrumentId)) continue;

    const gross = dec(tx.quantity).times(dec(tx.price));
    const fees = dec(tx.fees);
    const fx = dec(tx.fxRateToBase);
    const amountPLN =
      tx.side === 'buy'
        ? gross.plus(fees).times(fx).negated()
        : gross.minus(fees).times(fx);

    flows.push({ dateISO: tx.tradeDate, amountPLN });
  }

  // Ascending by date — a plain string compare, which is exactly right for
  // 'YYYY-MM-DD' and needs no Date.
  return flows.sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : 0));
}

/**
 * One day's external money movement, kept GROSS on both sides.
 *
 * **Why not a single net figure (bug audit 2026-08-19, major 1).** The net is
 * all TWRR needs on an ordinary day, but on a day the portfolio ends EMPTY the
 * two halves mean completely different things: the outflow is the sale's
 * proceeds (the day's ending wealth) while the inflow is capital that was put
 * in that morning and must sit in the denominator. Netting them destroys that
 * distinction, and the failure is silent and enormous — a 1 000 zł portfolio
 * that bought another 10 000 zł in the morning and liquidated the lot for
 * 12 100 zł in the afternoon nets to −2 100 zł and reads as +110 % where the
 * truth is 12 100 / 11 000 = +10 %. The gross figures are right here in the
 * transaction stream, so nothing has to be invented to keep them.
 *
 * Both fields are NON-NEGATIVE MAGNITUDES from the PORTFOLIO's perspective:
 * a buy is money INTO the portfolio (`inflowPLN`), a sale is money OUT
 * (`outflowPLN`). That is the negation of the investor cash flow XIRR uses —
 * getting the sign backwards would make every deposit read as a loss.
 */
export interface DayFlow {
  /** Money into the portfolio that day (purchases), >= 0. */
  inflowPLN: Decimal;
  /** Money out of the portfolio that day (sale proceeds), >= 0. */
  outflowPLN: Decimal;
}

/** A day with no external movement — the shared empty value, never `null`. */
export const NO_DAY_FLOW: DayFlow = { inflowPLN: ZERO, outflowPLN: ZERO };

/** `inflow − outflow`: the net an ordinary day's denominator still uses. */
export function netDayFlow(flow: DayFlow | undefined): Decimal {
  return flow === undefined ? ZERO : flow.inflowPLN.minus(flow.outflowPLN);
}

/**
 * The per-day EXTERNAL FLOW map TWRR needs, gross on both sides — see
 * `DayFlow`.
 */
export function externalFlowsByDay(flows: readonly CashFlow[]): Map<string, DayFlow> {
  const byDay = new Map<string, DayFlow>();
  for (const flow of flows) {
    const current = byDay.get(flow.dateISO) ?? NO_DAY_FLOW;
    // A negative investor amount is money leaving the investor, i.e. entering
    // the portfolio. `negated()`/`plus()` rather than a signed accumulator, so
    // the two directions can never collapse into one another.
    byDay.set(
      flow.dateISO,
      flow.amountPLN.isNegative()
        ? { ...current, inflowPLN: current.inflowPLN.plus(flow.amountPLN.negated()) }
        : { ...current, outflowPLN: current.outflowPLN.plus(flow.amountPLN) },
    );
  }
  return byDay;
}

/**
 * The external-flow map, SNAPPED onto the day axis the valuation series
 * actually has.
 *
 * Bug audit 2026-08-18, blocker 1: the flows used to be matched to the series
 * by an exact date-string lookup, so a trade dated on a weekend or a US market
 * holiday — a data-entry slip, or trade-date/settlement-date confusion —
 * matched no axis day at all and its deposit VANISHED from the chain. The
 * next trading day's jump in value was then booked as pure performance: a
 * 1 000 zł Saturday buy against a 1 000 zł portfolio read as +100 %.
 *
 * The rules, and the reconciliation that proves them:
 *
 * - A flow is snapped FORWARD to the first axis day on or after its date —
 *   the day the portfolio first shows the money, which is exactly the day
 *   whose denominator must include it.
 * - A flow dated before the axis starts accumulates onto the FIRST axis day,
 *   for the same reason.
 * - A flow dated after the last axis day has nowhere to go. It is NOT
 *   silently dropped: it is summed into `unmappedPLN` and its dates listed,
 *   and the caller turns any non-zero remainder into a disclosed refusal.
 *
 * `Σ byDay == Σ flows − unmappedPLN` holds by construction and is asserted in
 * the tests, because the silent-zero this replaces was invisible precisely
 * because nothing reconciled.
 */
export interface AxisFlows {
  /** axis day → gross external flow, portfolio perspective. */
  byDay: Map<string, DayFlow>;
  /** NET money no axis day could carry. The reconciliation figure. */
  unmappedPLN: Decimal;
  /**
   * The dates that money was dated on, ascending — for the log line and the
   * tests. **This, not `unmappedPLN`, is what the caller refuses on:** an
   * unmapped buy and an unmapped sale of the same size net to zero while both
   * are still missing from the chain.
   */
  unmappedDates: string[];
}

export function mapFlowsToAxis(
  flowsByDay: ReadonlyMap<string, DayFlow>,
  axisDates: readonly string[],
): AxisFlows {
  const byDay = new Map<string, DayFlow>();
  let unmappedPLN = ZERO;
  const unmappedDates: string[] = [];

  // The series builder emits its days sorted; sorting a copy costs nothing at
  // this size and means the snap cannot depend on that staying true.
  const axis = [...axisDates].sort();
  const dates = [...flowsByDay.keys()].sort();

  for (const dateISO of dates) {
    const amount = flowsByDay.get(dateISO);
    if (amount === undefined) continue;

    // The FX note the auditor asked for (2026-08-19): a weekend trade snapped
    // forward to Monday enters the chain carrying its own frozen trade-date
    // NBP rate, while the Monday axis point is valued at Monday's rate. The
    // gap is one to three NBP publications — tenths of a percent on the FLOW,
    // and it moves only the denominator of a single day, which is why it
    // stays below the rounding noise of the figures on screen. Correcting it
    // would mean revaluing a historical flow at a later rate, which is
    // precisely what a money-weighted return must never do (`fxRateToBase` is
    // frozen for exactly that reason). Left alone, deliberately.
    const target = axis.length === 0 ? undefined : firstOnOrAfter(axis, dateISO);
    if (target === undefined) {
      unmappedPLN = unmappedPLN.plus(netDayFlow(amount));
      unmappedDates.push(dateISO);
      continue;
    }
    const current = byDay.get(target) ?? NO_DAY_FLOW;
    byDay.set(target, {
      inflowPLN: current.inflowPLN.plus(amount.inflowPLN),
      outflowPLN: current.outflowPLN.plus(amount.outflowPLN),
    });
  }

  return { byDay, unmappedPLN, unmappedDates };
}

/**
 * The first axis day `>= dateISO`, or `undefined` when the date is past the
 * end of the axis. Plain 'YYYY-MM-DD' string comparison — the only correct
 * ordering for this format and the only one this feature uses.
 */
function firstOnOrAfter(axis: readonly string[], dateISO: string): string | undefined {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] < dateISO) lo = mid + 1;
    else hi = mid;
  }
  return lo < axis.length ? axis[lo] : undefined;
}
