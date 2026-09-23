import type { CalendarOverride } from './market-clock';
import type { SymbolMatch } from './symbol-search';

/**
 * The market-data contract — the only shape the rest of the app is allowed to
 * know. Providers (Massive today) implement this interface; nothing outside
 * `src/lib/market-data/` may import a vendor module directly.
 *
 * Types only, deliberately: no `server-only`, no env, no fetch — so unit tests
 * and isomorphic mapping code can import it freely. The vendor adapters that
 * implement it are `server-only`.
 *
 * Money discipline: every price on `Quote`/`Candle` is a **decimal string**,
 * produced by `dec(rawJsonNumber).toString()` at the vendor parse boundary and
 * consumed via `dec()` from `src/lib/money.ts`. A JS float never carries a
 * price through this contract.
 */

export interface Quote {
  symbol: string;
  /** Decimal string — `dec(json number)` at the vendor boundary, never a float. */
  price: string;
  /** Previous session close, same decimal-string boundary. Null when unknown. */
  prevClose: string | null;
  /** Timestamp of the price itself (already delayed on delayed plans). */
  asOf: Date;
  /**
   * Where `asOf` came from. `'trade'`/`'minute'` are real vendor timestamps;
   * `'fetch'` means the payload carried NO timestamp at all and `asOf` is
   * merely the fetch time — an upper bound, never a trade time. Any freshness
   * or "age" display MUST NOT present a `'fetch'` timestamp as if it dated
   * the price (plausible on delayed plans outside market hours, where the
   * price comes from `session.close` with no accompanying time).
   */
  asOfSource: 'trade' | 'minute' | 'fetch';
  /**
   * How far behind the live market this quote runs (900 on the Starter tier).
   * Contract data, kept required — but since 2026-08-10 (user-confirmed
   * reversal, plans/2026-08-10-holdings-live-market-view.md) the UI carries
   * NO obligation to render a delay label from it. The `'fetch'`-timestamp
   * honesty rule on `asOfSource` above still binds every consumer.
   */
  delaySeconds: number;
  marketStatus: 'open' | 'closed' | 'early_trading' | 'late_trading' | 'unknown';
  /**
   * Regular-session ("today") change vs the EFFECTIVE baseline — since
   * 2026-08-10 DERIVED from the displayed `price` via one atomic pair, both
   * figures or neither (REST payloads and streamed ticks share the same
   * derivation). The baseline is `prevClose` in every ordinary state; in the
   * pre-open ROLLED state (2026-08-14 fix: the vendor rolls `previous_close`
   * to equal the session close overnight, degenerating the pair to 0.00%)
   * the adapter substitutes the cached close of the session before the last
   * completed one, so the pair shows the last finished day's move —
   * Yahoo-style. `prevClose` itself always remains the VENDOR field and the
   * live tick baseline: `price − baseline = dayChangeAmt` and
   * `dayChangeAmt / baseline = dayChangePct` hold by construction either
   * way. Decimal strings through the same boundary as `price`; the pair is
   * null TOGETHER when underivable (including a missing cached baseline in
   * the rolled state) — never a fake `'0'`, never one without the other.
   */
  dayChangeAmt: string | null;
  /** A percentage (e.g. `'-0.0255'` means −0.0255%), not a ratio. */
  dayChangePct: string | null;
  /**
   * The session's own OHLV figures (2026-08-16, massive-tier0 plan) — the
   * fields the snapshot already carried and previously discarded. Prices and
   * VWAP are decimal strings through the same boundary as `price`; null when
   * the payload omits them. Outside regular hours the vendor's session object
   * describes the LAST COMPLETED session (and pre-open it may be rolled —
   * the `rolledPrevClose` caveat); consumers render what is there and never
   * attempt per-field roll detection.
   */
  dayOpen: string | null;
  dayHigh: string | null;
  dayLow: string | null;
  /**
   * Day's traded volume. A share COUNT, not money (the timestamp precedent):
   * it stays a plain JS number, never enters `dec()` arithmetic and never
   * needs to (12-digit US volumes sit far inside safe-integer range).
   * Formatted with `Intl.NumberFormat`, never `fmtMoney`. Null when absent.
   */
  // A count, not money — plain number by contract.
  dayVolume: number | null;
  /** Volume-weighted average price — money, decimal string like `price`. */
  vwap: string | null;
  /**
   * Extended-hours move measured from the regular-session close. LIVE while
   * that extended session runs (`early_trading`/`late_trading`): the vendor
   * pair, else derived close → extended price — both halves or neither.
   * While `closed`/`unknown` (2026-08-13 reversal of the 2026-08-10
   * only-while-running rule, plans/2026-08-13-extended-hours-last-reading.md
   * — Yahoo parity, user decision): the LAST COMPLETED extended session's
   * VENDOR pair persists, attributed by pure clock math
   * (`extendedAttribution` in market-clock.ts — the payload carries both
   * pairs side by side with no per-figure timestamp) and stamped with
   * `extendedEndedAtMs`; no staleness bound — the timestamp label is what
   * keeps it honest. No derived fallback while closed (session.price vs
   * session.close is not trustworthy as an extended move then). Null during
   * regular trading and whenever the attributed pair is incomplete.
   */
  extendedChangeAmt: string | null;
  extendedChangePct: string | null;
  /** Which extended session the figures describe; null exactly when both are null. */
  extendedKind: 'early' | 'late' | null;
  /**
   * Whether the attributed extended session is STILL RUNNING — liveness as
   * its OWN fact, never inferred from `extendedEndedAtMs === null` (an ended
   * session on a pre-horizon date honestly suppresses the instant yet must
   * still render dimmed). Meaningful only when `extendedKind` is non-null;
   * `false` otherwise. Invariant: `extendedLive ⇒ extendedEndedAtMs === null`.
   */
  extendedLive: boolean;
  /**
   * Epoch ms end of the attributed extended session — derived from session
   * bounds, NEVER borrowed from `session.last_updated`. Null while that
   * session is live or when no honest instant is derivable (then the UI shows
   * the session name with no time); meaningful only when `extendedKind` is
   * non-null. A timestamp, never money.
   */
  extendedEndedAtMs: number | null;
  /** Provider name, e.g. `'massive'` — stamped for honest source labelling. */
  source: string;
}

/**
 * The current US-equities session plus the boundaries the UI counts down to
 * and wakes up at. Timestamps are epoch ms — never money, never Decimal.
 */
export interface MarketSessionInfo {
  /** Vendor-reported when reachable; derived from the pure calendar otherwise. */
  status: Quote['marketStatus'];
  /** Next regular open/close boundary; null when not derivable in the scan bound. */
  nextTransitionAtMs: number | null;
  nextTransitionKind: 'open' | 'close' | null;
  /**
   * When quote polling becomes worthwhile again (the next early-session
   * start). Null while any session — regular or extended — is active.
   */
  pollingResumesAtMs: number | null;
}

/**
 * Per-symbol result: the snapshot API can fail one ticker inside a 200
 * response, and a stored non-US symbol (e.g. `CDR.WA`) must degrade to an
 * explicit `not_found` rather than silently vanishing or voiding the batch.
 */
export type QuoteOutcome =
  | { ok: true; quote: Quote }
  | {
      ok: false;
      symbol: string;
      reason: 'not_found' | 'unsupported' | 'error';
      message?: string;
    };

/**
 * One `/v2/aggs`-style bar request: multiplier × timespan over an inclusive
 * window. The vendor accepts both forms of bound; this contract pins which
 * one each granularity uses so callers cannot mix them by accident.
 */
export interface BarSpec {
  multiplier: number;
  timespan: 'minute' | 'hour' | 'day';
  /** `'YYYY-MM-DD'` for `day` windows; epoch ms (as a string) for intraday. */
  from: string;
  to: string;
}

export interface Candle {
  /** Bar-start in epoch milliseconds. A timestamp, not money — never fed to Decimal math. */
  t: number;
  /** Decimal strings, same boundary rule as `Quote.price`. */
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * One resolved brand icon, or an honest refusal. `not_found` covers every
 * graceful absence (no branding on the vendor side — e.g. non-US tickers —
 * a vendor 404, or an icon hosted off the vendor origin, which the adapter
 * refuses to authenticate against); `error` is transient and must never be
 * long-cached by callers.
 */
export type BrandingIconOutcome =
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; reason: 'not_found' | 'error' };

/**
 * One streamed price update — the delayed WebSocket's per-second aggregate
 * reduced to what the app consumes. The stream carries NO previous close and
 * NO change figures (verified live 2026-08-10): the day-change baseline always
 * comes from the REST snapshot, and consumers derive the pair themselves.
 */
export interface PriceTick {
  symbol: string;
  /** Decimal string — `dec(json number)` at the vendor boundary, never a float. */
  price: string;
  /** Aggregate end (epoch ms) — a timestamp, not money. */
  tMs: number;
}

export interface PriceStreamHandlers {
  onTick(tick: PriceTick): void;
  /**
   * The stream died. `'unauthorized'` is terminal for this plan (never retry
   * into other channels); `'error'`/`'closed'` are transient — callers may
   * reconnect. Called at most once per stream handle.
   */
  onDown(reason: 'unauthorized' | 'error' | 'closed'): void;
}

export interface PriceStreamHandle {
  /** Idempotent. Releases this subscriber; the vendor socket closes at zero. */
  close(): void;
}

/**
 * One cash-dividend event from the vendor's reference feed (2026-08-16,
 * dividends plan; entitlement VERIFIED LIVE the same day). `cashAmount` is
 * money and crosses the same decimal-string boundary as `Quote.price`; the
 * dates ride through as ISO strings verbatim. `frequency` (payments per
 * year) is a COUNT, not money — plain number by contract, the `dayVolume`
 * precedent.
 */
export interface DividendEvent {
  /** The vendor's own event id — the dedupe key for stored payments. */
  vendorId: string;
  /** Per share, decimal string — `dec(json number)` at the vendor boundary. */
  cashAmount: string;
  /** ISO 4217, uppercased; e.g. 'USD'. */
  currency: string;
  /** 'YYYY-MM-DD'. Eligibility is quantity held strictly BEFORE this date. */
  exDate: string;
  /** 'YYYY-MM-DD' | null — vendor rows can omit it; consumers then use exDate. */
  payDate: string | null;
  recordDate: string | null;
  declarationDate: string | null;
  /** Payments per year — a count, not money; plain number (dayVolume precedent). */
  frequency: number | null;
}

export interface SymbolSearchResult {
  results: SymbolMatch[];
  /**
   * True when the provider failed (non-2xx, timeout, network, parse) — as
   * opposed to a successful "no matches". `/api/symbols/search` depends on
   * the distinction to keep manual entry usable.
   */
  degraded: boolean;
}

/**
 * A company's classification, as the vendor states it. Every field is
 * independently nullable: a vendor that knows the SIC code but not the
 * industry description is the common case, and folding that into one
 * "unknown profile" would throw away the half it did answer.
 *
 * There is no country/domicile field: the provider does not expose one
 * (`address.country` is never populated and `locale` is the listing market,
 * always `'us'`), and no second vendor is permitted.
 */
export interface TickerProfile {
  /** Free-text industry description; the allocation's `sector` dimension. */
  sector: string | null;
  /** US SIC code as a STRING. A code, never arithmetic. */
  sicCode: string | null;
  /** Company description; trimmed, or null when the vendor has none. */
  description: string | null;
  /** Headcount; a tally, never money. Null when absent or unusable. */
  totalEmployees: number | null;
  /** http(s) homepage only — any other scheme is mapped to null upstream. */
  homepageUrl: string | null;
  /** Share count as a decimal string — multiplied by price later. */
  sharesOutstanding: string | null;
}

/**
 * A profile lookup's outcome, following `QuoteOutcome` / `BrandingIconOutcome`
 * (bug audit 2026-08-18, major 4).
 *
 * A bare `null` for every failure mode was the bug: the caller could not tell
 * "the vendor says this company has no classification" from "the vendor timed
 * out", wrote a null over a KNOWN sector either way and stamped the row as
 * freshly synced, so one blip moved a holding into "Unknown" for a month.
 *
 * - `ok: true` — the vendor answered. Whatever it says (including all nulls)
 *   is the truth about this ticker and may be written.
 * - `not_found` — DEFINITIVE: the vendor has no such ticker. Nothing to
 *   write, but the caller may stamp so it stops asking.
 * - `error` — transient (timeout, 5xx, unparseable body). The caller must
 *   leave BOTH the row and its timestamp exactly as they were.
 */
export type TickerProfileOutcome =
  | { ok: true; profile: TickerProfile }
  | { ok: false; reason: 'not_found' | 'error' };

export interface QuoteProvider {
  name: string;
  /** Plan-level delay, stamped onto every `Quote.delaySeconds`. */
  delaySeconds: number;
  /**
   * Batch quotes. Every requested symbol appears in the returned map — absent
   * upstream results are reconciled into `{ ok: false, reason: 'not_found' }`.
   */
  getQuotes(symbols: readonly string[]): Promise<Map<string, QuoteOutcome>>;
  /**
   * Aggregate bars at any granularity (daily history, 5/30-minute intraday).
   * One upstream call per symbol by API design — callers must not fan out
   * `Promise.all` over large symbol sets; iterate sequentially and bound the
   * set (see `MAX_BACKFILL_SYMBOLS` / `MAX_INTRADAY_SYMBOLS` in
   * `src/lib/history/`).
   */
  getAggregates(symbol: string, spec: BarSpec): Promise<Candle[]>;
  /**
   * Daily bars, `from`/`to` as `YYYY-MM-DD` (inclusive) — a thin alias over
   * `getAggregates` kept for its existing callers. The same fan-out warning
   * applies.
   */
  getDailyCloses(symbol: string, from: string, to: string): Promise<Candle[]>;
  searchSymbols(query: string): Promise<SymbolSearchResult>;
  /**
   * Cash-dividend history for one symbol, ex-dates on or after
   * `sinceExDateISO` ('YYYY-MM-DD'), ascending. One upstream call per symbol
   * by API design — the `getAggregates` fan-out warning applies verbatim:
   * iterate sequentially, never `Promise.all` a symbol set. Throws on vendor
   * failure; the caller (the dividends sync) degrades per instrument.
   */
  getDividends(symbol: string, sinceExDateISO: string): Promise<DividendEvent[]>;
  /**
   * Current session + next transition + poll-resume instant. Never throws:
   * vendor failure degrades to the purely derived calendar status.
   */
  getMarketStatus(): Promise<MarketSessionInfo>;
  /**
   * The vendor's holiday / early-close calendar as market-clock overrides.
   * Exposed because session BOUNDS — not just the current phase — are needed
   * off the live path too: classifying each intraday bar as pre-market,
   * regular or after-hours is `regularSessionFor(date, overrides)` on the
   * charted date. Cached hard upstream and never throws — with no calendar at
   * all the pure weekday schedule still stands, so the worst case is an
   * early-close day whose after-hours band starts three hours late.
   */
  getCalendarOverrides(): Promise<CalendarOverride[]>;
  /**
   * The company's square brand-icon bytes, fetched server-side so the vendor
   * URL (which requires the API key) never reaches a client. Never throws —
   * every failure mode lands in a `{ ok: false }` outcome. NOT for the quote
   * poll path: only the logo asset route may call this.
   */
  getBrandingIcon(symbol: string): Promise<BrandingIconOutcome>;
  /**
   * The company's classification — sector and SIC code — for the
   * analytics allocation breakdown. One upstream call per symbol by API
   * design, so the `getAggregates` fan-out warning applies VERBATIM: the only
   * caller (`src/lib/instruments/profile.ts`) bounds the set and pools the
   * concurrency.
   *
   * **Never throws, and always says WHICH kind of nothing it got:** a 404 is
   * a definitive `not_found`, every transient failure is `error`, and a
   * vendor answer with no industry on it is `ok` with a null `sector`. The
   * caller stamps `profile_synced_at` on the two definitive outcomes — which
   * is what stops a permanently unclassifiable ticker from being re-asked
   * forever — and stamps NOTHING on `error`, which is what stops one blip
   * from wiping a known classification for a month.
   */
  getTickerProfile(symbol: string): Promise<TickerProfileOutcome>;
  /**
   * Continuous price ticks over the vendor's delayed WebSocket, server-side
   * only — the SSE route is the sole caller and the client never sees the
   * vendor socket. Failures surface through `handlers.onDown`, never a throw
   * after the handle resolves.
   */
  streamPrices(
    symbols: readonly string[],
    handlers: PriceStreamHandlers,
  ): Promise<PriceStreamHandle>;
  /**
   * One direct, uncached probe of the vendor with the configured key — the
   * Settings health surface. Deliberately BYPASSES every in-process cache and
   * every degrade-and-continue path (a health check that answers from cache
   * is decorative). Never throws: 2xx → `'ok'`, an auth rejection (401/403)
   * → `'unauthorized'`, anything else (timeout, network, 5xx) →
   * `'unreachable'`. Called only on `/settings` loads — never polled.
   */
  checkKeyHealth(): Promise<'ok' | 'unauthorized' | 'unreachable'>;
}
