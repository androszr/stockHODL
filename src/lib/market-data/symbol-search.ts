import { CURRENCIES } from '@/lib/validation';

/**
 * Pure symbol-search domain types. Deliberately isomorphic with no server
 * marker (same rationale as `validation.ts`: reads neither env nor the
 * database) so unit tests and client components can import it directly. The
 * vendor fetch lives in `massive.ts`; the local fallback in
 * `symbol-directory.ts`.
 *
 * There is deliberately NO exchange→currency map here: both search paths put
 * exchange DISPLAY NAMES (never MIC codes) into `SymbolMatch.exchange`, and
 * `currency` is stamped directly by `rankDirectoryMatches` — always `'USD'`,
 * guaranteed by the US-only filters upstream of it.
 */

export type SupportedCurrency = (typeof CURRENCIES)[number];

export interface SymbolMatch {
  /** Ticker in provider notation — class shares use dots, e.g. `BRK.A`. */
  symbol: string;
  /** Company or fund name — entries without one are dropped upstream. */
  name: string;
  /** Exchange identifier — for US results this is the display name itself. */
  exchange: string;
  /** Human-readable exchange, e.g. `NYSE` — what the form field receives. */
  exchangeDisplay: string;
  type: 'equity' | 'etf';
  /** Only present when the exchange is confidently mapped. */
  currency?: SupportedCurrency;
}

/**
 * Query bounds and result cap, here rather than in `search.ts` for one
 * reason: `src/lib/api/contracts/` must stay isomorphic — the codegen script
 * imports it from plain Node — and `search.ts` reaches the vendor through
 * `massive.ts`, which is `server-only`. This module already has no server
 * marker, so a contract can read these without dragging the provider in.
 */
export const MAX_SEARCH_QUERY_LENGTH = 40;
export const MAX_SEARCH_RESULTS = 8;
