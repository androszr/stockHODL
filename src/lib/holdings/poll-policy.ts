import type { Quote, QuoteOutcome } from '@/lib/market-data/provider';

/**
 * The quote-poll gating policy — pure and isomorphic (no `server-only`, no
 * fetch, no env) so the client component and the server builder share ONE
 * definition and the unit tests can import it directly.
 *
 * The point of this module is a distinction one derived boolean cannot carry:
 *
 * - STRUCTURAL: the portfolio holds nothing the vendor can price (e.g. only
 *   `CDR.WA`, which Massive answers with `not_found`). Polling every 10 s
 *   would fetch the same nulls forever — correctly skip the cadence.
 * - TRANSIENT: the vendor hiccupped (timeout / 500 / parse failure) and ONE
 *   payload came back with every price null. The cadence must keep running so
 *   the view self-heals on the next good poll.
 *
 * Deriving "anything pollable?" from whether prices came back conflates the
 * two and permanently kills the 10 s interval on a single blip — the client
 * gate therefore consumes only the server-computed structural verdict below,
 * which is derived from the symbol set actually SENT to the vendor and its
 * per-symbol verdicts, never from this round's prices.
 */

/** Statuses during which the quote cadence runs (regular + extended hours). */
const ACTIVE_STATUSES: ReadonlySet<Quote['marketStatus']> = new Set([
  'open',
  'early_trading',
  'late_trading',
]);

export function isActiveStatus(status: Quote['marketStatus']): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * The structural fact: does this portfolio hold anything the vendor might
 * price? `not_found` / `unsupported` are the vendor's *structural* verdicts
 * on a symbol; `ok` and `error` (timeout, HTTP failure, parse failure — all
 * transient by nature) both count as pollable. An empty outcome set (no
 * symbols at all) is structural absence.
 */
export function hasPollableSymbols(outcomes: Iterable<QuoteOutcome>): boolean {
  for (const outcome of outcomes) {
    if (outcome.ok) return true;
    if (outcome.reason !== 'not_found' && outcome.reason !== 'unsupported') return true;
  }
  return false;
}

/**
 * The client's interval gate: poll while a session is running AND the
 * portfolio structurally has something to poll for. Deliberately blind to
 * whether the latest payload carried prices — see the module doc.
 */
export function shouldPollQuotes(
  status: Quote['marketStatus'],
  hasPollable: boolean,
): boolean {
  return isActiveStatus(status) && hasPollable;
}
