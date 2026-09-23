import { deriveDayPair } from '@/lib/market-data/massive-mapping';
import type { MarketSessionInfo, PriceTick, Quote } from '@/lib/market-data/provider';
import {
  dec,
  directionOf,
  fmtMoney,
  fmtPct,
  pctChange,
  toNumeric,
  type Direction,
} from '@/lib/money';
import {
  computePositions,
  displayablePositions,
  type EngineTransaction,
} from '@/lib/position-engine';
import type { TrendSlot } from '@/lib/trend/day-trend';

import { computePortfolioSummary } from './summary';

/**
 * Pure payload composition — isomorphic like `summary.ts`: no `server-only`,
 * no DB, no fetch. Decimal in via `money.ts`, pre-formatted strings out —
 * "Decimal never crosses the client boundary" (the live-view doctrine) is
 * enforced HERE, which is why the SSE stream route can recompose a fresh
 * `LivePayload` on every tick without re-hitting the DB, FX or the vendor's
 * REST API: `loadHoldingsInputs()` (live-view.ts) loads once per connection,
 * `applyPriceTick()` + `composeLivePayload()` run per tick.
 *
 * Extracted verbatim from `live-view.ts` (2026-08-10, live-quote-stream plan);
 * the composition semantics — wrong-currency guard, missing-FX exclusion,
 * '—' over fake zeros — are unchanged and unit-tested here.
 */

/** What the quote map carries per symbol — engine + summary + card, one shape. */
export interface HoldingQuote {
  /** Decimal string, per share, in `currency` — the displayed headline price. */
  price: string;
  currency: string;
  /** Day-pair baseline, kept so streamed ticks can re-derive the pair. */
  prevClose: string | null;
  dayChangeAmt: string | null;
  dayChangePct: string | null;
  /**
   * Session OHLV pass-through for the ticker page's stats row (2026-08-16,
   * massive-tier0 plan) — optional so every existing composition compiles
   * unchanged; `fetchQuotesBestEffort` always fills them. They ride through
   * `applyPriceTick`'s spreads untouched (REST-refresh cadence only — a tick
   * moves the price, not the day's range). Prices/vwap are decimal strings;
   * `dayVolume` is a COUNT, not money — a plain number, never `dec()` math.
   */
  dayOpen?: string | null;
  dayHigh?: string | null;
  dayLow?: string | null;
  dayVolume?: number | null;
  vwap?: string | null;
  extendedChangePct: string | null;
  extendedKind: 'early' | 'late' | null;
  /**
   * Epoch ms end of the attributed extended session; null while that session
   * is live or when no honest instant exists. A timestamp, never money —
   * derived upstream from session bounds only, never borrowed from the
   * vendor's snapshot-wide timestamp field.
   */
  extendedEndedAtMs: number | null;
  /**
   * Whether that session is still running — liveness as its own fact, never
   * inferred from `extendedEndedAtMs === null` (an ended session on a
   * pre-horizon date suppresses the instant yet must render as ended).
   * Meaningful only when `extendedKind` is non-null; invariant:
   * `extendedLive ⇒ extendedEndedAtMs === null`.
   */
  extendedLive: boolean;
}

/**
 * An engine transaction that still remembers which portfolio it came from —
 * the only thing per-portfolio scoping needs. Optional so every existing
 * caller (the ticker page, the tests) keeps compiling and simply gets no
 * scopes.
 */
export interface ScopedEngineTransaction extends EngineTransaction {
  portfolioId?: string;
}

/** Identity of one portfolio — the chip row's raw material. */
export interface PortfolioRef {
  id: string;
  name: string;
}

/** Everything a payload composition needs besides the quotes map. */
export interface HoldingsInputs {
  engineTxs: ScopedEngineTransaction[];
  /** currency → latest NBP mid rate to PLN (valuation rate, never D-1 tax). */
  fxRates: Map<string, string>;
  market: MarketSessionInfo;
  hasPollableSymbols: boolean;
  /**
   * The user's portfolios in display order, INCLUDING empty ones (they still
   * deserve a chip). Absent → no scopes are composed at all, which is what
   * every non-Holdings caller wants.
   */
  portfolios?: readonly PortfolioRef[];
  /**
   * Last SAVED quotes (the `latest_quotes` cache) for symbols whose live
   * fetch failed transiently — display-only fallback material. `fetchedAtMs`
   * is the FETCH time and is labelled as such downstream (the
   * `asOfSource: 'fetch'` honesty rule) — never presented as a trade time.
   * Absent → no cached fallbacks compose at all.
   */
  cachedQuotes?: ReadonlyMap<string, { price: string; currency: string; fetchedAtMs: number }>;
  /**
   * instrumentId → the five-day trend strip. Loaded in `loadHoldingsInputs`
   * and read by the STATIC composer, so `composeHoldingsView` stays pure and
   * the stream route can go on recomposing per tick without a second DB hit.
   * Absent → no strip composes at all, which is what every caller that does
   * not need one wants.
   */
  trends?: ReadonlyMap<string, TrendSlot[]>;
  /** The summed book's strip, loaded beside `trends` — see `fetchHoldingsTotalTrendBestEffort`. */
  summaryTrend?: TrendSlot[];
}

/** A signed, pre-formatted figure plus its `directionOf()` token choice. */
export interface LiveFigure {
  text: string;
  direction: Direction;
}

export interface LiveHolding {
  instrumentId: string;
  /** Formatted native-currency price; null when no usable quote arrived. */
  price: string | null;
  /**
   * The last SAVED price, formatted, with its fetch instant — set ONLY when
   * `price` is null and a currency-matching cached row exists (null-lockstep:
   * `cachedPrice` never coexists with a non-null `price`). Display-only by
   * decision: it never feeds the engine, the summary or the totals —
   * `excludedSymbols` honesty is untouched, and the day pair stays null on
   * cached rows (a "today" figure from a possibly-yesterday cache would lie).
   * `asOfMs` is the FETCH time, formatted client-side and labelled "cached".
   */
  cachedPrice: { text: string; asOfMs: number } | null;
  /** Today's regular-session move; null when unknown — rendered "—", never 0. */
  dayPct: LiveFigure | null;
  /**
   * Labeled extended-hours move. `live` is the liveness fact (its own field —
   * never inferred from `endedAtMs === null`, which also covers an ended
   * session with an unvouched instant); while the market is closed it carries
   * the LAST COMPLETED extended session's reading with that session's end
   * instant — epoch ms, formatted CLIENT-side so the device wall clock
   * applies (null when no honest instant exists: the label then shows no
   * time). Null during regular trading and whenever underivable.
   */
  extended:
    | (LiveFigure & { kind: 'early' | 'late'; live: boolean; endedAtMs: number | null })
    | null;
  /** Formatted PLN amount, '+'-signed on gains; null without quote + rate. */
  unrealizedPLN: string | null;
  /** fmtPct output — already '—' when the percentage is undefined. */
  unrealizedPct: string;
  direction: Direction;
  /**
   * Position market value in PLN (quantity × price × fx), pre-formatted and
   * unsigned — a value, not a change. Rendered from the last close when the
   * market is closed, exactly like `summary.totalValuePLN` — never blanked
   * outside market hours. Null without a usable quote + FX rate, and on
   * zero-quantity (oversold-at-zero) rows — "—", never a fake 0,00 zł.
   */
  valuePLN: string | null;
  /**
   * Unformatted decimal-string twin of `valuePLN`, for client-side ORDERING
   * only — never rendered (comparing the pl-PL display string would need the
   * forbidden parse-back). Null exactly when `valuePLN` is null; carries the
   * same figure at full precision, nothing the formatted field does not
   * already expose.
   */
  valuePLNRaw: string | null;
  /** Unformatted decimal-string twin of `unrealizedPLN` — same contract. */
  unrealizedPLNRaw: string | null;
}

export interface LiveMarket {
  status: Quote['marketStatus'];
  nextTransitionAtMs: number | null;
  nextTransitionKind: 'open' | 'close' | null;
  pollingResumesAtMs: number | null;
  /** Server clock at build time — lets the client spot gross skew if needed. */
  serverNowMs: number;
}

export interface LiveSummary {
  totalValue: string | null;
  dayChange: LiveFigure | null;
  totalChange: LiveFigure | null;
  /**
   * The percent halves of `dayChange`/`totalChange` on their own, for a
   * renderer with no room for the amount — the lock-screen and small
   * Home Screen widgets, which show a value and two percentages.
   *
   * Emitted from the SAME Decimal and the same `fmtPct` as the parenthesised
   * half of `text`, at the same site, so the two can never disagree. The
   * alternative — a client splitting `"+123,45 zł (+0,84%)"` on a bracket —
   * would be a second, string-shaped implementation of a number this file
   * already has. Null exactly when the amount has no percent to quote (no
   * basis to measure against), which is also when `text` carries the amount
   * alone.
   */
  dayChangePct: string | null;
  totalChangePct: string | null;
  /** Open positions the summary could not price — named, never zeroed. */
  excludedSymbols: string[];
  partialDayChange: boolean;
  /** The whole book's five-session strip; absent when nothing can be graded. */
  trend?: TrendSlot[];
}

/**
 * The same two live halves, recomputed for ONE portfolio's transactions. The
 * scoped Holdings view (`/?p=<id>`) renders these instead of the top-level
 * pair — which is what keeps `/api/quotes*` free of query parameters: every
 * payload carries every scope, and the client SELECTS one. It never asks for
 * one (docs/context.md — the symbol set comes from the caller's own rows).
 */
export interface LiveScope {
  id: string;
  summary: LiveSummary;
  holdings: LiveHolding[];
}

export interface LivePayload {
  market: LiveMarket;
  summary: LiveSummary;
  holdings: LiveHolding[];
  /** One entry per portfolio, in `inputs.portfolios` order; `[]` when absent. */
  scopes: LiveScope[];
  /**
   * STRUCTURAL fact for the client's poll gate: does this portfolio hold
   * anything the vendor might price? Derived from the symbol set SENT to the
   * vendor and its per-symbol verdicts (`not_found`/`unsupported` = no,
   * `ok`/transient `error` = yes) — never from whether prices came back this
   * round, so a vendor blip that nulls every price cannot stop the cadence.
   */
  hasPollableSymbols: boolean;
}

/** '+'-signed money on gains, mirroring the existing card convention. */
export function signedMoney(value: ReturnType<typeof dec>, currency: string): string {
  const formatted = fmtMoney(value, currency);
  return directionOf(value) === 'gain' ? `+${formatted}` : formatted;
}

/**
 * Applies one streamed tick to the quotes map, status-aware, and returns a
 * NEW map (the input is never mutated; an unknown symbol returns the input
 * unchanged). This is where the coherent-triple invariant survives a tick:
 *
 * - `open`: the tick IS the new headline price, and the day pair re-derives
 *   from the same `prevClose` baseline via `deriveDayPair` — the identical
 *   helper the REST mapper uses, so `price − prevClose = change` holds
 *   mid-stream exactly as it does at snapshot time. An underivable pair
 *   (no baseline) nulls BOTH figures — a moved price beside a stale change
 *   would be precisely the incoherence this plan removes.
 * - `early_trading`/`late_trading`: the headline stays the official close
 *   (D1 — outside regular hours the big number is the close); the tick moves
 *   the extended line instead, derived close → tick atomically.
 * - any other status: ignored — no stream should be open then, and the
 *   untouched map is what preserves a correctly-stale extended reading (its
 *   `extendedEndedAtMs` label included) while the market is closed.
 */
export function applyPriceTick(
  quotes: ReadonlyMap<string, HoldingQuote>,
  tick: PriceTick,
  status: Quote['marketStatus'],
): ReadonlyMap<string, HoldingQuote> {
  // Vendor tick symbols arrive uppercase; the map is keyed by stored symbols.
  const tickUpper = tick.symbol.toUpperCase();
  let key: string | null = null;
  for (const k of quotes.keys()) {
    if (k.toUpperCase() === tickUpper) {
      key = k;
      break;
    }
  }
  if (key === null) return quotes;
  const quote = quotes.get(key);
  if (quote === undefined) return quotes;

  let updated: HoldingQuote;
  if (status === 'open') {
    const pair = deriveDayPair(quote.prevClose, tick.price);
    updated = {
      ...quote,
      price: tick.price,
      dayChangeAmt: pair?.amt ?? null,
      dayChangePct: pair?.pct ?? null,
    };
  } else if (status === 'early_trading' || status === 'late_trading') {
    const pair = deriveDayPair(quote.price, tick.price);
    if (pair === null) return quotes;
    updated = {
      ...quote,
      extendedChangePct: pair.pct,
      extendedKind: status === 'early_trading' ? 'early' : 'late',
      // A live tick is by definition not a completed session's reading — pin
      // the instant to null so a tick can never resurrect a stale label, and
      // the liveness fact to true for the same reason.
      extendedEndedAtMs: null,
      extendedLive: true,
    };
  } else {
    return quotes;
  }

  const next = new Map(quotes);
  next.set(key, updated);
  return next;
}

/** The three per-symbol display figures a quote yields for one instrument. */
export interface QuoteFigures {
  price: LiveHolding['price'];
  dayPct: LiveHolding['dayPct'];
  extended: LiveHolding['extended'];
}

/**
 * Quote → display figures for ONE instrument: the currency guard, the
 * `dec()`/`fmtPct`/`directionOf` mapping and the extended passthrough,
 * extracted move-only from `composeLivePayload` so any per-symbol payload
 * composition shares the exact same figure semantics ('—' over fake zeros,
 * wrong-currency quote → all-null). Pure; only formatted strings leave.
 */
export function quoteFigures(
  quote: HoldingQuote | undefined,
  currency: string,
): QuoteFigures {
  // The engine applies the same guard; mirroring it here keeps a displayed
  // price consistent with any money figure it sits next to.
  const usable = quote && quote.currency === currency ? quote : undefined;

  const dayPctDec = usable?.dayChangePct != null ? dec(usable.dayChangePct) : null;
  const extPctDec =
    usable?.extendedKind != null && usable.extendedChangePct !== null
      ? dec(usable.extendedChangePct)
      : null;

  return {
    price: usable ? fmtMoney(dec(usable.price), currency) : null,
    dayPct:
      dayPctDec === null ? null : { text: fmtPct(dayPctDec), direction: directionOf(dayPctDec) },
    extended:
      extPctDec === null || usable?.extendedKind == null
        ? null
        : {
            kind: usable.extendedKind,
            live: usable.extendedLive,
            endedAtMs: usable.extendedEndedAtMs,
            text: fmtPct(extPctDec),
            direction: directionOf(extPctDec),
          },
  };
}

/**
 * The summary + card figures for ONE set of transactions — the whole
 * portfolio, or a single portfolio's slice of it. Extracted so a scope can
 * never drift from the total: both go through this exact function, and the
 * per-portfolio figures are therefore the same arithmetic the top-level
 * numbers are, run over fewer rows.
 */
function composeSlice(
  engineTxs: readonly EngineTransaction[],
  fxRates: ReadonlyMap<string, string>,
  quotes: ReadonlyMap<string, HoldingQuote>,
  cachedQuotes?: HoldingsInputs['cachedQuotes'],
): { summary: LiveSummary; holdings: LiveHolding[] } {
  // Open positions plus oversold-at-zero ones — the oversold badge must stay
  // reachable in exactly the case it exists for (sell entered before its buy).
  const open = displayablePositions(computePositions([...engineTxs], quotes, fxRates));

  const summary = computePortfolioSummary(open, quotes, fxRates);

  const holdings: LiveHolding[] = open.map((p) => {
    // The engine applied the same guard; mirroring it here keeps the card's
    // price display consistent with the P/L it sits next to.
    const quote = quotes.get(p.symbol);
    const usable = quote && quote.currency === p.currency ? quote : undefined;

    // price / dayPct / extended — the shared per-symbol figure mapping.
    const figures = quoteFigures(quote, p.currency);

    // Percent against the PLN cost basis. `pctChange` returns null on a zero
    // basis (oversold-at-zero) and fmtPct renders it "—" — never +0.00%.
    const pct =
      p.unrealizedPLN === null
        ? null
        : pctChange(p.costBasisPLN, p.costBasisPLN.plus(p.unrealizedPLN));

    // Market value in PLN — the exact guard chain of summary.ts (usable quote,
    // rate present, quantity > 0), so a card's value can never disagree with
    // the total it sums into. All Decimal via money.ts; only the formatted
    // string crosses to the client.
    const rate = usable ? (p.currency === 'PLN' ? '1' : fxRates.get(p.currency)) : undefined;
    const valueDec =
      usable && rate !== undefined && p.quantity.greaterThan(0)
        ? p.quantity.times(dec(usable.price)).times(dec(rate))
        : null;

    // Cached fallback — ONLY when the live price is null (a transient vendor
    // failure; `not_found`/`unsupported` symbols get no cache row upstream)
    // and the cached row's currency matches the instrument. The same
    // wrong-currency guard as the live figure: a cached USD price on a PLN
    // instrument would sit beside PLN money it can never reconcile with.
    const cachedEntry = figures.price === null ? cachedQuotes?.get(p.symbol) : undefined;
    const cachedPrice =
      cachedEntry !== undefined && cachedEntry.currency === p.currency
        ? { text: fmtMoney(dec(cachedEntry.price), p.currency), asOfMs: cachedEntry.fetchedAtMs }
        : null;

    return {
      instrumentId: p.instrumentId,
      price: figures.price,
      cachedPrice,
      dayPct: figures.dayPct,
      extended: figures.extended,
      unrealizedPLN: p.unrealizedPLN === null ? null : signedMoney(p.unrealizedPLN, 'PLN'),
      unrealizedPct: fmtPct(pct),
      direction: directionOf(p.unrealizedPLN),
      // Formatted and raw emit from the SAME Decimal (or the same null) — the
      // null-lockstep invariant the sort comparator depends on.
      valuePLN: valueDec === null ? null : fmtMoney(valueDec, 'PLN'),
      valuePLNRaw: valueDec === null ? null : toNumeric(valueDec),
      unrealizedPLNRaw: p.unrealizedPLN === null ? null : toNumeric(p.unrealizedPLN),
    };
  });

  const liveSummary: LiveSummary = {
    totalValue: summary.totalValuePLN === null ? null : fmtMoney(summary.totalValuePLN, 'PLN'),
    dayChange:
      summary.dayChangePLN === null
        ? null
        : {
            text:
              summary.dayChangePct === null
                ? signedMoney(summary.dayChangePLN, 'PLN')
                : `${signedMoney(summary.dayChangePLN, 'PLN')} (${fmtPct(summary.dayChangePct)})`,
            direction: directionOf(summary.dayChangePLN),
          },
    totalChange:
      summary.totalChangePLN === null
        ? null
        : {
            text:
              summary.totalChangePct === null
                ? signedMoney(summary.totalChangePLN, 'PLN')
                : `${signedMoney(summary.totalChangePLN, 'PLN')} (${fmtPct(summary.totalChangePct)})`,
            direction: directionOf(summary.totalChangePLN),
          },
    dayChangePct:
      summary.dayChangePLN === null || summary.dayChangePct === null
        ? null
        : fmtPct(summary.dayChangePct),
    totalChangePct:
      summary.totalChangePLN === null || summary.totalChangePct === null
        ? null
        : fmtPct(summary.totalChangePct),
    excludedSymbols: summary.excludedSymbols,
    partialDayChange: summary.partialDayChange,
  };

  return { summary: liveSummary, holdings };
}

/**
 * Inputs + quotes → the serializable poll/stream payload. Runs the position
 * engine and the summary internally so a per-tick recomposition can never
 * drift from what the page's initial render computed.
 *
 * When `inputs.portfolios` is present the payload additionally carries one
 * `LiveScope` per portfolio, composed from that portfolio's transactions
 * through the very same `composeSlice`. The cost is one engine pass per
 * portfolio over a subset of the rows — negligible at one user, and it is
 * what lets the client switch scope without a request.
 */
export function composeLivePayload(
  inputs: HoldingsInputs,
  quotes: ReadonlyMap<string, HoldingQuote>,
): LivePayload {
  const total = composeSlice(inputs.engineTxs, inputs.fxRates, quotes, inputs.cachedQuotes);

  const scopes: LiveScope[] = (inputs.portfolios ?? []).map((portfolio) => {
    const slice = composeSlice(
      inputs.engineTxs.filter((t) => t.portfolioId === portfolio.id),
      inputs.fxRates,
      quotes,
      inputs.cachedQuotes,
    );
    return { id: portfolio.id, ...slice };
  });

  return {
    market: { ...inputs.market, serverNowMs: Date.now() },
    summary: { ...total.summary, trend: inputs.summaryTrend },
    holdings: total.holdings,
    scopes,
    hasPollableSymbols: inputs.hasPollableSymbols,
  };
}

/**
 * The session stats the ticker page's `DayStats` row renders, pre-formatted
 * for a client that cannot be trusted with a float.
 *
 * Same currency guard as {@link quoteFigures}, and for the same reason: a
 * wrong-currency quote must render dashes rather than a plausible number in
 * the wrong money. Every absent field is `null`, never a fabricated 0 — a
 * stock that has not opened has no open, and "0,00" would be a claim.
 *
 * `volume` is a COUNT, not money: it is grouped with `Intl.NumberFormat`
 * directly and never passes through `dec()`/`fmtMoney` (non-negotiable #1
 * covers prices, quantities, fees and FX rates — a traded-share tally is a
 * tally).
 */
export interface DayStatsFigures {
  prevClose: string | null;
  dayOpen: string | null;
  dayLow: string | null;
  dayHigh: string | null;
  volume: string | null;
  vwap: string | null;
}

const VOLUME_FORMAT = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });

export function dayStatsFigures(
  quote: HoldingQuote | undefined,
  currency: string,
): DayStatsFigures {
  const usable = quote && quote.currency === currency ? quote : undefined;
  const money = (value: string | null | undefined): string | null =>
    value === undefined || value === null ? null : fmtMoney(dec(value), currency);

  return {
    prevClose: money(usable?.prevClose),
    dayOpen: money(usable?.dayOpen),
    dayLow: money(usable?.dayLow),
    dayHigh: money(usable?.dayHigh),
    volume:
      usable?.dayVolume === undefined || usable.dayVolume === null
        ? null
        : VOLUME_FORMAT.format(usable.dayVolume),
    vwap: money(usable?.vwap),
  };
}
