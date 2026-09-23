import { z } from 'zod';

import { dec, pctChange } from '@/lib/money';
import { dateStringSchema } from '@/lib/validation';

import { extendedAttribution, type CalendarOverride, type MarketTransition } from './market-clock';
import type { DirectoryRow } from './nasdaq-directory';
import type {
  OptionContractRef,
  OptionQuote,
  OptionQuoteOutcome,
} from './options-types';
import type {
  BarSpec,
  Candle,
  DividendEvent,
  PriceTick,
  Quote,
  QuoteOutcome,
} from './provider';

/**
 * Pure mapping between Massive's REST payloads and the `QuoteProvider`
 * contract. Deliberately isomorphic with no server marker (same rationale as
 * `symbol-search.ts`: reads neither env nor the database) so the unit tests
 * can import it directly. The fetch, auth and caching live in `massive.ts`.
 *
 * THE MONEY BOUNDARY lives here and nowhere else. Massive serializes prices
 * as JSON numbers; after `JSON.parse` they are already `number`s — there is
 * nothing left to string-parse. Every price field goes straight into `dec(raw)`
 * (decimal.js converts a JS number via its shortest round-trip decimal
 * representation — exactly the digits Massive serialized) and is emitted as a
 * decimal STRING. No arithmetic ever happens on the raw number.
 *
 * Timestamps are not money: `sip_timestamp` is nanoseconds, which exceeds
 * Number.MAX_SAFE_INTEGER (~2^53) and so carries ~hundreds-of-ns error after
 * JSON.parse — irrelevant at the millisecond precision the freshness label
 * needs. They are converted to ms for `Date` and never fed to money math.
 */

/* ------------------------------------------------------------------ *
 * Zod schemas — loose on purpose. Massive adds and removes keys
 * freely, and unknown extras must never fail the parse. Every field is
 * optional; the mappers drop unusable entries instead of the schema
 * rejecting the whole body (same philosophy as the old search schemas).
 * ------------------------------------------------------------------ */

const snapshotTradeSchema = z.looseObject({
  price: z.number().optional(),
  /** Nanoseconds since epoch — a timestamp, not money. */
  sip_timestamp: z.number().optional(),
  last_updated: z.number().optional(),
});

const snapshotMinuteSchema = z.looseObject({
  close: z.number().optional(),
  last_updated: z.number().optional(),
});

/**
 * The `session` object as observed live 2026-08-10. `change`/`change_percent`
 * are deliberately NOT used for the daily figure — observed closed-market
 * payloads show them tracking the extended-hours move (they equalled the
 * late-trading fields), i.e. they conflate exactly the two things the UI
 * separates. Since the coherent-triple decision (2026-08-10, live-quote-stream
 * plan) the `regular_trading_*` pair is SCHEMA-ONLY: the display path derives
 * the day pair from the displayed price against `previous_close` instead, so
 * price/change/percent always agree with each other — and so REST payloads
 * and streamed ticks (which carry no vendor change fields at all) share one
 * derivation. The `early_trading_*` / `late_trading_*` pairs are SCHEMA-ONLY
 * too (2026-08-14, extended-pair-self-derived plan): observed live (NFLX
 * pre-market 2026-08-14) that the early pair is measured from
 * `previous_close` — the close TWO sessions back — double-counting the
 * previous regular session's move the day figure already shows, while the
 * late pair matched a close-based computation on another ticker the same
 * day. A pair with an inconsistent base cannot be trusted anywhere, so the
 * extended figure is self-derived from `close` → `price` in both extended
 * branches instead.
 */
const snapshotSessionSchema = z.looseObject({
  previous_close: z.number().optional(),
  close: z.number().optional(),
  change: z.number().optional(),
  change_percent: z.number().optional(),
  price: z.number().optional(),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  volume: z.number().optional(),
  vwap: z.number().optional(),
  regular_trading_change: z.number().optional(),
  regular_trading_change_percent: z.number().optional(),
  early_trading_change: z.number().optional(),
  early_trading_change_percent: z.number().optional(),
  late_trading_change: z.number().optional(),
  late_trading_change_percent: z.number().optional(),
  /** Nanoseconds since epoch — a timestamp, not money. */
  last_updated: z.number().optional(),
});

export const snapshotResultSchema = z.looseObject({
  ticker: z.string().optional(),
  type: z.string().optional(),
  market_status: z.string().optional(),
  /** A single ticker can fail inside a 200 — `error`/`message` per result. */
  error: z.string().optional(),
  message: z.string().optional(),
  last_trade: snapshotTradeSchema.optional(),
  last_minute: snapshotMinuteSchema.optional(),
  session: snapshotSessionSchema.optional(),
});

export type SnapshotResult = z.infer<typeof snapshotResultSchema>;

export const snapshotResponseSchema = z.looseObject({
  results: z.array(snapshotResultSchema).optional(),
  next_url: z.string().optional(),
});

const tickerItemSchema = z.looseObject({
  ticker: z.string().optional(),
  name: z.string().optional(),
  /** ISO 10383 MIC, e.g. `XNYS`, `XNAS`. */
  primary_exchange: z.string().optional(),
  type: z.string().optional(),
  locale: z.string().optional(),
  /** Lowercase in the wild, e.g. `"usd"`. */
  currency_name: z.string().optional(),
  active: z.boolean().optional(),
});

export type TickerItem = z.infer<typeof tickerItemSchema>;

export const tickersResponseSchema = z.looseObject({
  results: z.array(tickerItemSchema).optional(),
});

/**
 * `/v3/reference/tickers/{ticker}` — only the branding corner of the payload.
 * Everything optional and `branding` nullable: verified live 2026-08-10 that
 * `.WA` tickers return `branding: null`, and the loose-schema philosophy above
 * applies — unknown extras must never fail the parse.
 */
export const tickerOverviewSchema = z.looseObject({
  results: z
    .looseObject({
      branding: z
        .looseObject({
          icon_url: z.string().optional(),
          logo_url: z.string().optional(),
        })
        .nullish(),
    })
    .optional(),
});

export type TickerOverview = z.infer<typeof tickerOverviewSchema>;

/**
 * Extracts the brand ICON url (`icon_url` — the square tile, per the settled
 * interview decision; `logo_url` is the wide lockup and is deliberately not
 * used). Anything that is not an https URL maps to null: the adapter treats
 * null as "no logo" and the card renders its monogram — never a key sent
 * toward a non-https destination.
 */
export function mapBrandingIconUrl(parsed: TickerOverview): string | null {
  const url = parsed.results?.branding?.icon_url;
  if (url === undefined || url === null) return null;
  return url.startsWith('https://') ? url : null;
}

/**
 * The CLASSIFICATION corner of the same `/v3/reference/tickers/{ticker}`
 * payload the branding path already fetches — sector and SIC code for the
 * analytics allocation breakdown.
 *
 * No country/domicile is read: probed live 2026-08-18, `results.address` has
 * no `country` key on any ticker, and `results.locale` is `'us'` for every
 * ticker (it means "listed on a US market", not "domiciled in"). There is no
 * honest domicile in this payload, so nothing is mapped from it.
 *
 * Same loose-schema philosophy as everything above: every field optional,
 * `results` nullish (verified live 2026-08-10 that `.WA` tickers answer with
 * a mostly-empty `results`), unknown extras never fail the parse. A field the
 * vendor does not return maps to `null`, permanently and VISIBLY — the
 * allocation puts those holdings in a named "Unknown" bucket rather than
 * hiding them.
 */
export const tickerProfileSchema = z.looseObject({
  results: z
    .looseObject({
      /** Free-text industry description, e.g. 'Electronic Computers'. */
      sic_description: z.string().nullish(),
      /** Four-digit US SIC code AS A STRING — a code, never arithmetic. */
      sic_code: z.string().nullish(),
      description: z.string().nullish(),
      homepage_url: z.string().nullish(),
      total_employees: z.number().nullish(),
      weighted_shares_outstanding: z.number().nullish(),
      share_class_shares_outstanding: z.number().nullish(),
    })
    .nullish(),
});

export type TickerProfilePayload = z.infer<typeof tickerProfileSchema>;

/** What the analytics layer stores per instrument; every field independently null. */
export interface TickerProfileFields {
  sector: string | null;
  sicCode: string | null;
  description: string | null;
  totalEmployees: number | null;
  homepageUrl: string | null;
  sharesOutstanding: string | null;
}

/** Trimmed, or null when the value is absent or blank. */
function text(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Only a parseable http(s) URL survives — the phone renders this as a link. */
function httpUrl(value: string | null | undefined): string | null {
  const trimmed = text(value);
  if (trimmed === null) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** Non-negative integer or null — refuse negatives, NaN, and fractions. */
function nonNegInt(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Share count as a decimal string. `weighted` wins when present; otherwise
 * the share-class figure. Non-finite values never cross `dec()`.
 */
function sharesOutstandingString(
  weighted: number | null | undefined,
  shareClass: number | null | undefined,
): string | null {
  const raw = weighted ?? shareClass;
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return null;
  return dec(raw).toString();
}

/** Pure mapper — no network, unit-tested. */
export function mapTickerProfile(parsed: TickerProfilePayload): TickerProfileFields {
  const results = parsed.results;
  return {
    sector: text(results?.sic_description),
    sicCode: text(results?.sic_code),
    description: text(results?.description),
    totalEmployees: nonNegInt(results?.total_employees),
    homepageUrl: httpUrl(results?.homepage_url),
    sharesOutstanding: sharesOutstandingString(
      results?.weighted_shares_outstanding,
      results?.share_class_shares_outstanding,
    ),
  };
}

const aggBarSchema = z.looseObject({
  o: z.number().optional(),
  h: z.number().optional(),
  l: z.number().optional(),
  c: z.number().optional(),
  v: z.number().optional(),
  /** Bar-start in ms — a timestamp, not money. */
  t: z.number().optional(),
});

export type AggBar = z.infer<typeof aggBarSchema>;

export const aggsResponseSchema = z.looseObject({
  results: z.array(aggBarSchema).optional(),
});

/* ------------------------------------------------------------------ *
 * Exchange / type filters — conservative on purpose. An unknown MIC or
 * type drops the row (same philosophy as `EXCHANGE_NAMES` in
 * nasdaq-directory.ts): `instruments.currency` is first-write-wins, so
 * a wrongly guessed listing binds a symbol permanently.
 * ------------------------------------------------------------------ */

/** US MIC codes → display names; mirrors `EXCHANGE_NAMES` for the directory. */
export const US_MIC_NAMES: Record<string, string> = {
  XNYS: 'NYSE',
  XNAS: 'Nasdaq',
  XASE: 'NYSE American',
  ARCX: 'NYSE Arca',
  BATS: 'Cboe BZX',
  IEXG: 'IEX',
};

/** Massive ticker types worth surfacing for manual lot entry. ADRC keeps
 *  US-listed ADRs like TSM (the Nasdaq directory includes them too); rights,
 *  warrants, funds and units are dropped as noise. */
const TICKER_TYPES: Record<string, 'equity' | 'etf'> = {
  CS: 'equity',
  ADRC: 'equity',
  ETF: 'etf',
};

type KnownMarketStatus = Exclude<Quote['marketStatus'], 'unknown'>;

const MARKET_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'closed',
  'early_trading',
  'late_trading',
] satisfies KnownMarketStatus[]);

/** The one sanctioned number→Decimal crossing: shortest round-trip digits out. */
function decString(raw: number): string {
  return dec(raw).toString();
}

/**
 * The atomic change pair: amount AND percent from the same two inputs, null
 * TOGETHER — never one without the other. Null when either side is absent or
 * the base is zero (`pctChange` semantics: an undefined percentage must not
 * render as 0.00%). Accepts decimal strings (streamed ticks, stored quotes)
 * and raw JSON numbers (snapshot fields) — both cross through `dec()`.
 *
 * This is THE day-pair derivation for REST payloads and streamed ticks alike:
 * deriving both figures from the displayed price makes the invariant
 * `price − prevClose = amt` and `amt / prevClose = pct` hold by construction.
 */
export function deriveDayPair(
  prevClose: string | number | null | undefined,
  price: string | number | null | undefined,
): { amt: string; pct: string } | null {
  if (prevClose === undefined || prevClose === null || price === undefined || price === null) {
    return null;
  }
  const from = dec(prevClose);
  const to = dec(price);
  const pct = pctChange(from, to);
  if (pct === null) return null;
  return { amt: to.minus(from).toString(), pct: pct.toString() };
}

/**
 * Detects the vendor's overnight ROLLED state (defect fix, 2026-08-14):
 * sometime before the pre-open the vendor rolls `previous_close` forward to
 * equal the last session's close — exactly the headline the non-open branch
 * displays — so every derived day pair collapses to a degenerate 0.00% while
 * the market visibly moves pre-market. The payload signature is
 * `prevClose === price` (Decimal equality, not string equality — '75.10' and
 * '75.1' are one number) with a non-open status; the roll instant itself is
 * not knowable, so the signature is read off the data. The one false
 * positive — a genuinely flat completed session, pre-roll — is harmless by
 * construction: substitution then derives prior-close → close, which is the
 * same honest figure the vendor pair gave.
 */
export function rolledPrevClose(quote: Quote): boolean {
  return (
    quote.marketStatus !== 'open' &&
    quote.prevClose !== null &&
    dec(quote.prevClose).eq(dec(quote.price))
  );
}

/**
 * Replaces a rolled quote's day pair with one measured from the LAST
 * COMPLETED session's own baseline — the prior close the caller read from
 * `price_snapshots` — Yahoo's pre-open behavior: yesterday's move, not a
 * fake 0.00%. The coherent triple survives: the displayed price is untouched
 * (still the official close) and the pair derives from it atomically via
 * `deriveDayPair` — both figures or neither; a null/unavailable baseline
 * yields a null pair (the UI's dash), never a fabricated zero.
 *
 * `prevClose` is deliberately NOT overwritten: `applyPriceTick` re-derives
 * the day pair from `quote.prevClose` when the status flips to `open`, and
 * the vendor's rolled `previous_close` is precisely the CORRECT baseline for
 * the regular session — overwriting it would show a wrong day figure from
 * 09:30 ET until the next SSE reconnect. During `early_trading`, ticks only
 * move the extended line, so the substituted pair survives streaming.
 */
export function substituteDayPair(quote: Quote, priorClose: string | null): Quote {
  const pair = deriveDayPair(priorClose, quote.price);
  return { ...quote, dayChangeAmt: pair?.amt ?? null, dayChangePct: pair?.pct ?? null };
}

const NS_PER_MS = 1e6;

type SnapshotSession = z.infer<typeof snapshotSessionSchema>;
type SnapshotMinute = z.infer<typeof snapshotMinuteSchema>;

/**
 * Status-aware headline selection (coherent-triple decision, 2026-08-10),
 * extracted 2026-08-15 so the option-pricing path can read an UNDERLYING's
 * spot out of the same mixed snapshot batch with byte-identical semantics —
 * one rule, one place, no second definition of "the price".
 *
 * While open, `session.price` is what the vendor's own session figures track —
 * the coherent live price. Outside regular hours (incl. `unknown`) the
 * headline is the official close, exactly Yahoo's behavior; the extended move
 * lives on its own line. `last_trade` is NOT in either chain: this plan's
 * snapshots never carry it (verified live 2026-08-10), and its instant would
 * disagree with the session figures anyway. `??` keeps a legitimate price of
 * 0 (it only skips null/undefined).
 */
export function headlineSessionPrice(
  session: SnapshotSession | undefined,
  lastMinute: SnapshotMinute | undefined,
  marketStatus: Quote['marketStatus'],
): number | undefined {
  return marketStatus === 'open'
    ? (session?.price ?? lastMinute?.close ?? session?.close)
    : (session?.close ?? lastMinute?.close ?? session?.price);
}

/**
 * Maps one `/v3/snapshot` result to a per-symbol outcome. Never throws; an
 * entry without a ticker is unusable for reconciliation and returns null (the
 * adapter drops it — requested symbols still get `not_found` outcomes there).
 */
export function mapSnapshotResult(
  raw: SnapshotResult,
  ctx: {
    delaySeconds: number;
    source: string;
    now: Date;
    /** MERGED holiday/early-close calendar (durable store + fresh vendor
     *  list) for the closed-branch extended attribution. */
    overrides: readonly CalendarOverride[];
    /** The calendar store's coverage horizon ('YYYY-MM-DD' | null) — dates
     *  before it get no attributed instant, only the session name. */
    calendarKnownFromISO: string | null;
  },
): QuoteOutcome | null {
  const symbol = raw.ticker;
  if (!symbol) return null;

  if (raw.error !== undefined) {
    return { ok: false, symbol, reason: 'error', message: raw.message ?? raw.error };
  }

  // `type` is only asserted when present — the Starter payload may omit it.
  if (raw.type !== undefined && raw.type !== 'stocks') {
    return { ok: false, symbol, reason: 'unsupported', message: `type=${raw.type}` };
  }

  const marketStatus: Quote['marketStatus'] =
    raw.market_status !== undefined && MARKET_STATUSES.has(raw.market_status)
      ? (raw.market_status as KnownMarketStatus)
      : 'unknown';

  const session = raw.session;

  const price = headlineSessionPrice(session, raw.last_minute, marketStatus);
  if (price === undefined || price === null) {
    return { ok: false, symbol, reason: 'error', message: 'no usable price field' };
  }

  const prevCloseRaw = session?.previous_close;

  // ns → ms. The raw ns value exceeds Number.MAX_SAFE_INTEGER, so it already
  // carries ~hundreds-of-ns error after JSON.parse — harmless at ms precision.
  // Timestamps never enter money math.
  //
  // asOfSource makes any synthesis explicit: when the payload carries no
  // timestamp at all (plausible on delayed plans outside market hours),
  // asOf falls back to fetch time — an upper bound that must never be read
  // as a trade time, which `'fetch'` announces to every consumer.
  const tradeNs = raw.last_trade?.sip_timestamp ?? raw.last_trade?.last_updated;
  const minuteNs = raw.last_minute?.last_updated;
  let asOf: Date;
  let asOfSource: Quote['asOfSource'];
  if (tradeNs !== undefined) {
    asOf = new Date(Math.floor(tradeNs / NS_PER_MS));
    asOfSource = 'trade';
  } else if (minuteNs !== undefined) {
    asOf = new Date(Math.floor(minuteNs / NS_PER_MS));
    asOfSource = 'minute';
  } else {
    asOf = ctx.now;
    asOfSource = 'fetch';
  }

  // Daily change — DERIVED from the headline price chosen above against the
  // vendor's canonical `previous_close`, as one atomic pair. The vendor's
  // regular-session pair stays schema-only (see the session schema doc):
  // deriving from the displayed price is the only method that keeps the
  // price/change/percent triple coherent at every instant AND works
  // identically for streamed ticks, which carry no vendor change fields.
  // One downstream exception (2026-08-14): in the pre-open ROLLED state the
  // vendor's `previous_close` already equals this headline, so the adapter
  // substitutes the pair's BASELINE with the cached prior close
  // (`rolledPrevClose` / `substituteDayPair`) — the displayed price and the
  // atomic derivation are unchanged, only the base the pair measures from.
  const dayPair = deriveDayPair(session?.previous_close, price);
  const dayChangeAmt = dayPair?.amt ?? null;
  const dayChangePct = dayPair?.pct ?? null;

  // Extended-hours change — SELF-DERIVED, session close → session price, in
  // BOTH branches (2026-08-14 decision, extended-pair-self-derived plan). The
  // vendor's `early_trading_*` / `late_trading_*` pairs are schema-only (see
  // the session schema doc): the early pair was observed measured from
  // `previous_close` — the close TWO sessions back — double-counting the day
  // move the day figure already shows, and the late pair disagreed with that
  // base on another ticker the same day; a pair with an inconsistent base
  // cannot be trusted anywhere. LIVE while an extended session runs (the
  // vendor's per-ticker status is authoritative): derived atomically from
  // session close → live extended price — both figures or neither. While
  // unambiguously `closed` (2026-08-13 reversal of the 2026-08-10
  // only-while-running rule — Yahoo parity, user decision): the LAST
  // COMPLETED extended session's reading persists, attributed by pure clock
  // math (`extendedAttribution` — the payload keeps both vendor pairs side by
  // side with no per-figure timestamp, so recency is not readable off it) and
  // stamped with that session's derived end instant. The persisted line
  // renders iff the attribution is non-null AND the derivation succeeds
  // (both `session.close` and `session.price` present, non-zero base —
  // `deriveDayPair` enforces atomicity). "Never an older session's figure
  // relabelled" holds by construction: `session.price` is the most recent
  // trade and can never predate `session.close`, so the derived span only
  // covers time AFTER the official close — the attributed session's window,
  // or a genuinely flat 0%. `open` carries no extended figures at all: the
  // day figure already contains the pre-market move, and showing both would
  // double-count it. The persisted branch is `closed`-ONLY (2026-08-14 fix):
  // an unrecognised vendor status maps to `unknown` and renders NO extended
  // line — it may be a live half-day session (e.g. `half_day`), and
  // attributing it as closed put a persisted pre-market pair next to a day
  // figure that already contained the move, counting it twice.
  let extendedKind: Quote['extendedKind'] = null;
  let extendedChangeAmt: string | null = null;
  let extendedChangePct: string | null = null;
  let extendedEndedAtMs: number | null = null;
  let extendedLive = false;
  if (marketStatus === 'early_trading' || marketStatus === 'late_trading') {
    const pair = deriveDayPair(session?.close, session?.price);
    // Underivable end to end → no extended figure at all, never a fake one.
    if (pair !== null) {
      extendedKind = marketStatus === 'early_trading' ? 'early' : 'late';
      extendedChangeAmt = pair.amt;
      extendedChangePct = pair.pct;
      // Live by definition — the instant belongs to a COMPLETED session only.
      extendedLive = true;
    }
  } else if (marketStatus === 'closed') {
    const attribution = extendedAttribution(
      ctx.now.getTime(),
      ctx.overrides,
      ctx.calendarKnownFromISO,
    );
    if (attribution !== null) {
      const pair = deriveDayPair(session?.close, session?.price);
      // Attribution AND a successful derivation, or nothing — no vendor pair
      // can conjure a line, and an absent tip renders none.
      if (pair !== null) {
        extendedKind = attribution.kind;
        extendedChangeAmt = pair.amt;
        extendedChangePct = pair.pct;
        extendedEndedAtMs = attribution.endedAtMs;
        // The clock is the arbiter: vendor-says-closed inside a still-running
        // window (halt/lag) stays live and renders exactly as today.
        extendedLive = attribution.live;
      }
    }
  }

  // Session OHLV (2026-08-16, massive-tier0 plan): the fields the payload
  // already carried, previously parsed and dropped. Prices/vwap through the
  // one sanctioned `decString` crossing; volume is a COUNT, not money — it
  // stays a plain JSON number end to end (never `dec()` arithmetic).
  const optionalPrice = (value: number | undefined): string | null =>
    value === undefined || value === null ? null : decString(value);

  return {
    ok: true,
    quote: {
      symbol,
      price: decString(price),
      prevClose: prevCloseRaw === undefined || prevCloseRaw === null ? null : decString(prevCloseRaw),
      asOf,
      asOfSource,
      delaySeconds: ctx.delaySeconds,
      marketStatus,
      dayChangeAmt,
      dayChangePct,
      dayOpen: optionalPrice(session?.open),
      dayHigh: optionalPrice(session?.high),
      dayLow: optionalPrice(session?.low),
      // A count, not money — plain number, never through decString.
      dayVolume: session?.volume ?? null,
      vwap: optionalPrice(session?.vwap),
      extendedChangeAmt,
      extendedChangePct,
      extendedKind,
      extendedEndedAtMs,
      extendedLive,
      source: ctx.source,
    },
  };
}

/**
 * Maps `/v3/reference/tickers` results to `DirectoryRow`s — the same shape the
 * local directory emits, so `rankDirectoryMatches()` produces the final
 * `SymbolMatch[]` with one ranking algorithm for primary and fallback (and it
 * already stamps `currency: 'USD'`, which the filters below guarantee).
 *
 * US-only, explicitly: non-US locale, non-USD currency, inactive listings,
 * unknown MICs and noise types (rights, warrants, funds, units) are dropped
 * here — a rejection, not a silent absence.
 */
export function mapTickerResults(items: readonly TickerItem[]): DirectoryRow[] {
  const rows: DirectoryRow[] = [];

  for (const item of items) {
    if (!item.ticker || !item.name) continue;
    if (item.locale !== 'us') continue;
    if (item.active === false) continue;
    if (item.currency_name?.toUpperCase() !== 'USD') continue;

    const type = item.type !== undefined ? TICKER_TYPES[item.type] : undefined;
    if (!type) continue;

    const exchange = item.primary_exchange !== undefined ? US_MIC_NAMES[item.primary_exchange] : undefined;
    if (!exchange) continue;

    rows.push({ symbol: item.ticker, name: item.name, exchange, type });
  }

  return rows;
}

/**
 * Pure `/v2/aggs` path builder:
 * `/v2/aggs/ticker/{sym}/range/{mult}/{timespan}/{from}/{to}`.
 *
 * Every segment goes through `encodeURIComponent`, so a dot ticker (`BRK.A`)
 * stays a single segment and anything hostile (`../`, an embedded `/`, a `?`)
 * is neutralized into the segment instead of restructuring the URL. The
 * symbol is the only caller-influenced segment — it comes from the user's own
 * DB rows, but the encoding means even a hand-crafted row cannot escape the
 * path.
 */
export function aggsPath(symbol: string, spec: BarSpec): string {
  const seg = (value: string | number) => encodeURIComponent(String(value));
  return (
    `/v2/aggs/ticker/${seg(symbol)}/range/${seg(spec.multiplier)}` +
    `/${seg(spec.timespan)}/${seg(spec.from)}/${seg(spec.to)}`
  );
}

/**
 * Maps `/v2/aggs` daily bars to `Candle`s. A bar missing any OHLCV field or
 * its timestamp is dropped — a partial bar is worse than no bar.
 */
export function mapAggsResults(bars: readonly AggBar[]): Candle[] {
  const candles: Candle[] = [];

  for (const bar of bars) {
    const { o, h, l, c, v, t } = bar;
    if (
      o === undefined ||
      h === undefined ||
      l === undefined ||
      c === undefined ||
      v === undefined ||
      t === undefined
    ) {
      continue;
    }
    candles.push({
      t,
      open: decString(o),
      high: decString(h),
      low: decString(l),
      close: decString(c),
      volume: decString(v),
    });
  }

  return candles;
}

/**
 * Query for one `/v3/snapshot` batch. Pure so the request-building is unit
 * testable: `limit` MUST equal the batch size — the API default is 10, so a
 * 40-ticker request without an explicit limit silently returns 10 results.
 *
 * `type` MUST NOT be sent: the endpoint rejects an explicit asset class
 * alongside a ticker list with `400 {"error":"Cannot specify tickers and
 * type."}` (verified live 2026-08-09). Naming the tickers already constrains
 * the asset class, so there is nothing to narrow. A hermetic unit test cannot
 * discover this rule — only the probe can.
 */
export function snapshotParams(symbols: readonly string[]): URLSearchParams {
  return new URLSearchParams({
    'ticker.any_of': symbols.join(','),
    limit: String(symbols.length),
  });
}

/* ------------------------------------------------------------------ *
 * Delayed WebSocket stream — the pure half. The socket, auth and
 * refcounting live in massive-stream.ts; the message schema and the
 * number→dec() crossing live here so unit tests can import them.
 * A-message shape verified live 2026-08-10:
 *   {ev:"A", sym, o, h, l, c, v, av, op, vw, a, z, s, e, dv, dav}
 * — s/e are bar start/end in ms (timestamps, not money). Status frames
 * ({ev:"status", status, message}) share the same loose schema.
 * ------------------------------------------------------------------ */

export const streamAggSchema = z.looseObject({
  ev: z.string().optional(),
  status: z.string().optional(),
  message: z.string().optional(),
  sym: z.string().optional(),
  /** Aggregate close — the only price the stream moves. */
  c: z.number().optional(),
  /** Bar start/end in epoch ms — timestamps, not money. */
  s: z.number().optional(),
  e: z.number().optional(),
});

export type StreamMessage = z.infer<typeof streamAggSchema>;

/**
 * One WebSocket text frame → messages. The vendor may send a bare object or
 * an array of them; garbage (non-JSON, unexpected shapes) maps to `[]` —
 * a malformed frame must never kill the socket.
 */
export function parseStreamFrame(raw: string): StreamMessage[] {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(body) ? body : [body];
  const messages: StreamMessage[] = [];
  for (const item of items) {
    const parsed = streamAggSchema.safeParse(item);
    if (parsed.success) messages.push(parsed.data);
  }
  return messages;
}

/**
 * One A-message → `PriceTick`, or null for anything unusable (non-`A` events,
 * missing symbol, missing close). `c` crosses through the same sanctioned
 * `dec()` boundary as every REST price — no arithmetic on the raw float.
 * `nowMs` is the fallback timestamp when the bar carries neither instant.
 */
export function mapStreamAgg(msg: StreamMessage, nowMs: number): PriceTick | null {
  if (msg.ev !== 'A') return null;
  if (!msg.sym) return null;
  if (msg.c === undefined || msg.c === null) return null;
  return { symbol: msg.sym, price: decString(msg.c), tMs: msg.e ?? msg.s ?? nowMs };
}

/* ------------------------------------------------------------------ *
 * Market status — the current-status endpoint and the upcoming
 * holiday/early-close calendar (fetched in massive.ts, composed with
 * market-clock.ts). Verified live 2026-08-10: the current-status body
 * carries NO next-transition timestamp, and the calendar body is a bare
 * JSON ARRAY whose full closures carry no times while early-close days
 * carry explicit UTC open/close instants.
 * ------------------------------------------------------------------ */

export const marketStatusNowSchema = z.looseObject({
  /** Observed values: 'open' | 'closed' | 'extended-hours'. */
  market: z.string().optional(),
  afterHours: z.boolean().optional(),
  earlyHours: z.boolean().optional(),
  serverTime: z.string().optional(),
});

export type MarketStatusNow = z.infer<typeof marketStatusNowSchema>;

/**
 * Current status only — no transition math here. The extended-hours booleans
 * are checked first because `market` collapses both extended sessions into
 * one word; anything unrecognized maps to `'unknown'`, never a guess.
 */
export function mapMarketStatusNow(raw: MarketStatusNow): Quote['marketStatus'] {
  if (raw.earlyHours === true) return 'early_trading';
  if (raw.afterHours === true) return 'late_trading';
  if (raw.market === 'open') return 'open';
  if (raw.market === 'closed') return 'closed';
  return 'unknown';
}

/**
 * Reconciles the vendor's live status word with the pure-clock transition
 * before the two are paired in one payload. The word is authoritative (ad-hoc
 * halts are in no calendar) but the transition instant is derived — and when
 * they disagree (the vendor's lag in the seconds after 16:00 ET says `open`
 * while the clock's next boundary is an OPEN, or the mirror case around
 * 09:30), pairing them verbatim renders self-contradictions like
 * "Open … opens in 17:29:58". Consistency rule: `open` pairs only with a
 * `close` transition, every other status only with an `open` transition;
 * a contradicting transition is suppressed (null) — the next poll, issued on
 * the retry cadence, self-corrects once vendor and clock agree again.
 */
export function reconcileTransition(
  status: Quote['marketStatus'],
  transition: MarketTransition | null,
): MarketTransition | null {
  if (transition === null) return null;
  return (transition.kind === 'close') === (status === 'open') ? transition : null;
}

const upcomingItemSchema = z.looseObject({
  /** NY calendar date, 'YYYY-MM-DD'. */
  date: z.string().optional(),
  /** Observed: 'NYSE' | 'NASDAQ' (one row per exchange per holiday). */
  exchange: z.string().optional(),
  name: z.string().optional(),
  /** Observed: 'closed' | 'early-close'. */
  status: z.string().optional(),
  /** ISO 8601 UTC instants; present only on early-close days. */
  open: z.string().optional(),
  close: z.string().optional(),
});

export type MarketUpcomingItem = z.infer<typeof upcomingItemSchema>;

/** The body is a bare JSON array — array-tolerant by construction. */
export const marketUpcomingSchema = z.array(upcomingItemSchema);

/** The US equity venues whose calendar rows apply to our quotes. */
const EQUITY_EXCHANGES: ReadonlySet<string> = new Set(['NYSE', 'NASDAQ']);

/**
 * Vendor calendar rows → `CalendarOverride[]` for market-clock. Rows repeat
 * per exchange; they are deduped by date with `closed` winning over
 * `early-close` (the conservative reading if the venues ever diverge).
 * `Date.parse` on the ISO instants is a timestamp conversion, not money.
 */
export function mapUpcomingToOverrides(items: readonly MarketUpcomingItem[]): CalendarOverride[] {
  const byDate = new Map<string, CalendarOverride>();

  for (const item of items) {
    if (!item.date || !item.status) continue;
    if (item.exchange !== undefined && !EQUITY_EXCHANGES.has(item.exchange.toUpperCase())) continue;

    if (item.status === 'closed') {
      byDate.set(item.date, { date: item.date, status: 'closed' });
      continue;
    }
    if (item.status !== 'early-close') continue;
    if (byDate.get(item.date)?.status === 'closed') continue;

    const openMs = item.open !== undefined ? Date.parse(item.open) : NaN;
    const closeMs = item.close !== undefined ? Date.parse(item.close) : NaN;
    byDate.set(item.date, {
      date: item.date,
      status: 'early-close',
      ...(Number.isFinite(openMs) ? { openMs } : {}),
      ...(Number.isFinite(closeMs) ? { closeMs } : {}),
    });
  }

  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/* ------------------------------------------------------------------ *
 * Options (2026-08-14, options-tracking plan) — ADDITIVE ONLY: the
 * unified `/v3/snapshot` endpoint accepts option tickers with its own
 * result shape, and `/v3/reference/options/contracts` powers the
 * drill-down picker. Everything below follows the loose-schema
 * philosophy above, and every strike/greek/IV/price crosses the SAME
 * sanctioned JSON-number→dec() boundary as equity prices. Vendor facts
 * verified live 2026-08-14 against our own key: option results carry
 * `type: "options"`, NO `last_trade`/`last_quote` on this tier (price
 * is `session.close`, day base `session.previous_close`), `greeks: {}`
 * and a MISSING `implied_volatility` key on illiquid contracts, and
 * `underlying_asset` carrying only `ticker`.
 * ------------------------------------------------------------------ */

const optionDetailsSchema = z.looseObject({
  contract_type: z.string().optional(),
  strike_price: z.number().optional(),
  expiration_date: z.string().optional(),
  exercise_style: z.string().optional(),
  shares_per_contract: z.number().optional(),
});

const optionGreeksSchema = z.looseObject({
  delta: z.number().optional(),
  gamma: z.number().optional(),
  theta: z.number().optional(),
  vega: z.number().optional(),
});

export const optionSnapshotResultSchema = z.looseObject({
  ticker: z.string().optional(),
  type: z.string().optional(),
  /** A single ticker can fail inside a 200 — `error`/`message` per result. */
  error: z.string().optional(),
  message: z.string().optional(),
  market_status: z.string().optional(),
  session: snapshotSessionSchema.optional(),
  details: optionDetailsSchema.optional(),
  greeks: optionGreeksSchema.optional(),
  implied_volatility: z.number().optional(),
  /** An integer count, never money. */
  open_interest: z.number().optional(),
  underlying_asset: z.looseObject({ ticker: z.string().optional() }).optional(),
});

export type OptionSnapshotResult = z.infer<typeof optionSnapshotResultSchema>;

export const optionSnapshotResponseSchema = z.looseObject({
  results: z.array(optionSnapshotResultSchema).optional(),
  next_url: z.string().optional(),
});

/**
 * ONE `/v3/snapshot` batch can mix option and stock tickers (verified live
 * 2026-08-14) — which is how a model mark gets its underlying's spot without
 * a second round trip. The mixed result schema is the union of both shapes:
 * every field stays optional and the object stays loose, so a stock result
 * simply carries no `details`/`greeks` and an option result carries no
 * `last_minute`. Nothing about either mapper changes.
 */
export const mixedSnapshotResultSchema = snapshotResultSchema.extend({
  details: optionDetailsSchema.optional(),
  greeks: optionGreeksSchema.optional(),
  implied_volatility: z.number().optional(),
  open_interest: z.number().optional(),
  underlying_asset: z.looseObject({ ticker: z.string().optional() }).optional(),
});

export type MixedSnapshotResult = z.infer<typeof mixedSnapshotResultSchema>;

export const mixedSnapshotResponseSchema = z.looseObject({
  results: z.array(mixedSnapshotResultSchema).optional(),
  next_url: z.string().optional(),
});

/**
 * A STOCK result from the mixed batch → the underlying's spot, as a decimal
 * string through the one sanctioned crossing. Pure, never throws, and
 * deliberately minimal: a spot is an input to a model estimate, not a
 * displayed quote, so nothing here derives a day pair, an extended reading or
 * a timestamp — `mapSnapshotResult` remains the only producer of a `Quote`.
 *
 * Null (a silent fallback, never an error) when the result failed, is not a
 * stock, has no ticker, or carries no usable price. The price itself is the
 * SAME status-aware headline every equity surface shows —
 * `headlineSessionPrice`, shared, not re-derived.
 */
export function mapUnderlyingSpot(
  raw: MixedSnapshotResult,
): { symbol: string; price: string } | null {
  const symbol = raw.ticker;
  if (!symbol) return null;
  if (raw.error !== undefined) return null;
  // The mixed batch is routed by `type`; a missing `type` on the Starter
  // payload is treated as a stock, exactly as `mapSnapshotResult` does.
  if (raw.type !== undefined && raw.type !== 'stocks') return null;

  const marketStatus: Quote['marketStatus'] =
    raw.market_status !== undefined && MARKET_STATUSES.has(raw.market_status)
      ? (raw.market_status as KnownMarketStatus)
      : 'unknown';

  const price = headlineSessionPrice(raw.session, raw.last_minute, marketStatus);
  if (price === undefined || price === null) return null;

  return { symbol, price: decString(price) };
}

const CONTRACT_TYPES = new Set(['call', 'put']);

/**
 * Maps one option `/v3/snapshot` result to a per-ticker outcome. Never
 * throws; an entry without a ticker is unusable for reconciliation and
 * returns null (the adapter drops it — requested tickers still get
 * `not_found` outcomes there).
 *
 * Headline price is `session.close` ALWAYS — verified 2026-08-14 that option
 * snapshots on this tier carry no `session.price` and no trade/quote objects,
 * so unlike equities there is no status-aware selection to make. The day pair
 * derives `previous_close` → `close` atomically via the SAME `deriveDayPair`
 * the equity path uses. Every absent greek and a missing
 * `implied_volatility` map to null — NEVER `'0'`: an illiquid contract's
 * unknown delta must not render as a delta of zero.
 */
export function mapOptionSnapshotResult(
  raw: OptionSnapshotResult,
  ctx: { delaySeconds: number; source: string; now: Date },
): OptionQuoteOutcome | null {
  const symbol = raw.ticker;
  if (!symbol) return null;

  if (raw.error !== undefined) {
    return { ok: false, symbol, reason: 'error', message: raw.message ?? raw.error };
  }

  // `type` is only asserted when present — the loose-schema philosophy.
  if (raw.type !== undefined && raw.type !== 'options') {
    return { ok: false, symbol, reason: 'unsupported', message: `type=${raw.type}` };
  }

  const session = raw.session;
  const price = session?.close;
  if (price === undefined || price === null) {
    return { ok: false, symbol, reason: 'error', message: 'no usable price field' };
  }

  const details = raw.details;
  const contractType = details?.contract_type;
  if (
    contractType === undefined ||
    !CONTRACT_TYPES.has(contractType) ||
    details?.strike_price === undefined ||
    details.expiration_date === undefined
  ) {
    return { ok: false, symbol, reason: 'error', message: 'incomplete contract details' };
  }

  const marketStatus: Quote['marketStatus'] =
    raw.market_status !== undefined && MARKET_STATUSES.has(raw.market_status)
      ? (raw.market_status as KnownMarketStatus)
      : 'unknown';

  const prevCloseRaw = session?.previous_close;
  const dayPair = deriveDayPair(prevCloseRaw, price);

  // Absent → null, never '0' (verified: illiquid contracts return
  // `greeks: {}` and omit `implied_volatility` entirely).
  const optionalDec = (value: number | undefined): string | null =>
    value === undefined ? null : decString(value);

  const quote: OptionQuote = {
    ticker: symbol,
    underlying: raw.underlying_asset?.ticker ?? null,
    price: decString(price),
    prevClose: prevCloseRaw === undefined || prevCloseRaw === null ? null : decString(prevCloseRaw),
    dayChangeAmt: dayPair?.amt ?? null,
    dayChangePct: dayPair?.pct ?? null,
    marketStatus,
    greeks: {
      delta: optionalDec(raw.greeks?.delta),
      gamma: optionalDec(raw.greeks?.gamma),
      theta: optionalDec(raw.greeks?.theta),
      vega: optionalDec(raw.greeks?.vega),
    },
    impliedVolatility: optionalDec(raw.implied_volatility),
    // A count passes through as a plain integer — never Decimal math.
    openInterest: raw.open_interest ?? null,
    contractType: contractType as 'call' | 'put',
    strikePrice: decString(details.strike_price),
    expirationDate: details.expiration_date,
    sharesPerContract:
      details.shares_per_contract === undefined ? '100' : decString(details.shares_per_contract),
    asOf: ctx.now,
    // No vendor trade timestamp exists on this tier — announced, never faked.
    asOfSource: 'fetch',
    delaySeconds: ctx.delaySeconds,
    source: ctx.source,
  };

  return { ok: true, quote };
}

/** Optional filters for `/v3/reference/options/contracts`. */
export interface OptionContractsFilters {
  contractType?: 'call' | 'put';
  expirationDate?: string;
  /** `expiration_date.gte` — the expiry-enumeration jump cursor. */
  expirationDateGte?: string;
  /** `expiration_date.lte` — upper bound of the nearby-expiry window. */
  expirationDateLte?: string;
  /** `strike_price.gte`/`.lte` — decimal strings, the nearby-strike window. */
  strikePriceGte?: string;
  strikePriceLte?: string;
  expired?: boolean;
  limit?: number;
  sort?: 'expiration_date' | 'strike_price';
  order?: 'asc' | 'desc';
}

/**
 * Pure query builder for the contracts-reference endpoint — VERIFIED
 * parameter names only (live probes 2026-08-14): `underlying_ticker`,
 * `contract_type`, `expiration_date`, `expiration_date.gte`,
 * `expiration_date.lte`, `strike_price.gte`, `strike_price.lte`, `expired`,
 * `limit`, `sort`, `order`. Everything goes through `URLSearchParams`, so
 * user-influenced values are always encoded, never string-interpolated.
 */
export function optionContractsParams(
  underlying: string,
  filters: OptionContractsFilters = {},
): URLSearchParams {
  const params = new URLSearchParams({ underlying_ticker: underlying });
  if (filters.contractType !== undefined) params.set('contract_type', filters.contractType);
  if (filters.expirationDate !== undefined) params.set('expiration_date', filters.expirationDate);
  if (filters.expirationDateGte !== undefined) {
    params.set('expiration_date.gte', filters.expirationDateGte);
  }
  if (filters.expirationDateLte !== undefined) {
    params.set('expiration_date.lte', filters.expirationDateLte);
  }
  if (filters.strikePriceGte !== undefined) {
    params.set('strike_price.gte', filters.strikePriceGte);
  }
  if (filters.strikePriceLte !== undefined) {
    params.set('strike_price.lte', filters.strikePriceLte);
  }
  if (filters.expired !== undefined) params.set('expired', String(filters.expired));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.sort !== undefined) params.set('sort', filters.sort);
  if (filters.order !== undefined) params.set('order', filters.order);
  return params;
}

const optionContractItemSchema = z.looseObject({
  ticker: z.string().optional(),
  underlying_ticker: z.string().optional(),
  contract_type: z.string().optional(),
  expiration_date: z.string().optional(),
  strike_price: z.number().optional(),
  shares_per_contract: z.number().optional(),
});

export type OptionContractItem = z.infer<typeof optionContractItemSchema>;

export const optionContractsResponseSchema = z.looseObject({
  results: z.array(optionContractItemSchema).optional(),
  next_url: z.string().optional(),
});

/**
 * Reference rows → `OptionContractRef[]`. A row missing its ticker, strike,
 * expiry, type or underlying is dropped — a partial contract identity is
 * worse than none. Strikes and `shares_per_contract` cross the sanctioned
 * number→`dec()` boundary here.
 */
export function mapOptionContracts(items: readonly OptionContractItem[]): OptionContractRef[] {
  const refs: OptionContractRef[] = [];
  for (const item of items) {
    if (!item.ticker || !item.underlying_ticker) continue;
    if (item.contract_type === undefined || !CONTRACT_TYPES.has(item.contract_type)) continue;
    if (item.strike_price === undefined || !item.expiration_date) continue;
    refs.push({
      ticker: item.ticker,
      underlying: item.underlying_ticker,
      contractType: item.contract_type as 'call' | 'put',
      strikePrice: decString(item.strike_price),
      expirationDate: item.expiration_date,
      sharesPerContract:
        item.shares_per_contract === undefined ? '100' : decString(item.shares_per_contract),
    });
  }
  return refs;
}

/**
 * The day AFTER an expiry, 'YYYY-MM-DD' — the `expiration_date.gte` cursor
 * for the next enumeration page (one contracts page spans only ~8 expiries,
 * verified 2026-08-14, so enumeration must jump). Pure UTC calendar math —
 * dates, not money; DST cannot touch a UTC day increment.
 */
export function nextExpirationQueryDate(lastExpiryISO: string): string {
  const [y, m, d] = lastExpiryISO.split('-');
  // Calendar components are counts, not money — parseInt is sanctioned here.
  const next = new Date(
    Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10) + 1),
  );
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/* ------------------------------------------------------------------ *
 * Dividends (2026-08-16, dividends plan) — the pure half of the
 * `/v3/reference/dividends` fetch. VERIFIED LIVE 2026-08-16 against the
 * real key: HTTP 200 with rows carrying `cash_amount` (JSON number),
 * `currency`, `declaration_date`, `dividend_type`, `ex_dividend_date`,
 * `frequency`, `id` (the vendor event id — the dedupe key), `pay_date`,
 * `record_date`, `ticker`, cursor-paginated via `next_url`. The MONEY
 * BOUNDARY rule applies: `cash_amount` crosses number→dec()→string here
 * and nowhere else; the dates pass through as ISO strings verbatim and
 * `frequency` stays a plain count (the dayVolume precedent).
 * ------------------------------------------------------------------ */

/**
 * A vendor date field, CONTENT-validated (2026-08-16 security pass): these
 * strings feed a Postgres `date` column and the lexical `effectiveDate >
 * today` future-skip in `dividends/sync.ts`, so a non-`YYYY-MM-DD` value is
 * not a date — it is garbage that would corrupt a tax-grade record or defeat
 * the skip. Validation goes through the ONE repo date helper
 * (`dateStringSchema`: format + real-calendar existence), and `.catch` keeps
 * the loose-schema philosophy intact: a malformed value degrades to
 * `undefined` (the mapper then drops the row or nulls the field) instead of
 * failing the whole response body.
 */
const vendorDateSchema = dateStringSchema.optional().catch(undefined);

/** One dividend result, loose on purpose (the snapshot-schema philosophy) —
 *  but the fields that get PERSISTED are content-checked, not just shaped. */
export const dividendResultSchema = z.looseObject({
  /** The vendor's own event id — rows without it cannot be deduped. */
  id: z.string().optional(),
  cash_amount: z.number().optional(),
  currency: z.string().optional(),
  declaration_date: vendorDateSchema,
  dividend_type: z.string().optional(),
  ex_dividend_date: vendorDateSchema,
  /** Payments per year — a count, not money. */
  frequency: z.number().optional(),
  pay_date: vendorDateSchema,
  record_date: vendorDateSchema,
  ticker: z.string().optional(),
});

export type DividendResult = z.infer<typeof dividendResultSchema>;

export const dividendsResponseSchema = z.looseObject({
  results: z.array(dividendResultSchema).optional(),
  next_url: z.string().optional(),
});

/**
 * Query for one dividends fetch. Pure like `snapshotParams` so the request
 * shape is unit-testable — though a hermetic test proves only that the
 * params are included, never that the vendor accepts them; `ticker`,
 * `ex_dividend_date.gte`, `limit`, `order` and `sort` are the parameter
 * names the plan's live probe exercised (2026-08-16).
 */
export function dividendsParams(symbol: string, sinceExDateISO: string): URLSearchParams {
  return new URLSearchParams({
    ticker: symbol,
    'ex_dividend_date.gte': sinceExDateISO,
    limit: '1000',
    order: 'asc',
    sort: 'ex_dividend_date',
  });
}

/**
 * The plausibility ceiling for a per-share cash amount (2026-08-16 security
 * pass). The column is `numeric(20,8)` (12 integer digits), but a per-share
 * dividend above $10,000 has never existed — the largest real specials sit in
 * the low thousands (Seaboard-class tickers) — so anything past this bound is
 * vendor garbage, not money, and persisting it would poison a tax-grade
 * record with a figure no correction UI expects. 1e6 leaves two orders of
 * headroom over any real payment while staying far inside the column.
 * Compared on the raw JSON number (exact in floats at this magnitude),
 * BEFORE the decString crossing.
 */
export const MAX_PLAUSIBLE_CASH_AMOUNT = 1_000_000;

/**
 * Dividend results → `DividendEvent[]`. A row missing `id`, `cash_amount` or
 * `ex_dividend_date` is DROPPED, never guessed — an event that cannot be
 * deduped or priced is worse than none (a malformed date string is degraded
 * to absent by the schema's `vendorDateSchema`, so it lands here as the same
 * drop/null path). `cash_amount` crosses the one sanctioned number→`dec()`
 * boundary and is bounded by {@link MAX_PLAUSIBLE_CASH_AMOUNT} — an
 * implausible value is dropped AND logged, never persisted; absent
 * `pay_date` / `record_date` / `declaration_date` map to null; an absent
 * `currency` defaults to 'USD' (the vendor is US-markets-only end to end —
 * the `fetchQuotesBestEffort` rationale).
 */
export function mapDividendResults(items: readonly DividendResult[]): DividendEvent[] {
  const events: DividendEvent[] = [];
  for (const item of items) {
    if (!item.id || !item.ex_dividend_date) continue;
    // `dividend_type` is deliberately NOT filtered (decision, 2026-08-16):
    // CD (regular) and SC (special) are both cash that reaches the account —
    // cash is cash — and the rarer LT/ST distribution codes still carry a
    // real `cash_amount`. What IS dropped is a zero or negative amount: a
    // payment of nothing is not a payment, and a stored zero-gross row would
    // be both noise in a tax record and uneditable (the correction schema
    // requires a positive gross). Sign check on the raw JSON number — exact
    // in floats — BEFORE the decString crossing; nothing is parsed here.
    if (item.cash_amount === undefined || item.cash_amount === null) continue;
    if (item.cash_amount <= 0) continue;
    if (item.cash_amount > MAX_PLAUSIBLE_CASH_AMOUNT) {
      // Dropped, and SAID so — a silent drop of a huge figure would be
      // indistinguishable from the vendor never publishing the event.
      console.warn(
        `Dividend event dropped — implausible cash_amount ${item.cash_amount} ` +
          `(${item.ticker ?? 'unknown ticker'}, event ${item.id}, ex ${item.ex_dividend_date})`,
      );
      continue;
    }
    events.push({
      vendorId: item.id,
      cashAmount: decString(item.cash_amount),
      currency: (item.currency ?? 'USD').toUpperCase(),
      exDate: item.ex_dividend_date,
      payDate: item.pay_date ?? null,
      recordDate: item.record_date ?? null,
      declarationDate: item.declaration_date ?? null,
      // A count, not money — plain number, never through decString.
      frequency: item.frequency ?? null,
    });
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * News (2026-08-16, watchlist-news-module plan) — the pure half of the
 * news fetch (the endpoint path itself lives in massive.ts, its ONLY
 * grep-able home). Verified live 2026-08-16: `/v2` is the only version
 * that answers (`/v1`/`/v3` are 404); working params are `ticker`
 * (SINGLE symbol — `ticker.any_of`/`tickers`/`ticker.in` are silently
 * ignored, and a comma list on `ticker` returns 0 results) and
 * `limit`; the envelope is the standard paged shape
 * `{ results, next_url, … }`. NO MONEY CROSSES HERE — news carries no
 * prices, so there is no dec() boundary in this section, only strings
 * and one timestamp parse.
 *
 * CRITICAL vendor fact (probed live): `?id=<hex>` is SILENTLY IGNORED
 * and the newest article comes back instead — so no by-id request
 * builder exists here or anywhere. The persisted rows are the only
 * source that can serve one specific article again.
 * ------------------------------------------------------------------ */

const newsPublisherSchema = z.looseObject({
  name: z.string().optional(),
  homepage_url: z.string().optional(),
  logo_url: z.string().optional(),
  favicon_url: z.string().optional(),
});

/**
 * One news result, loose on purpose (the snapshot-schema philosophy): every
 * field optional, unknown extras pass through. `insights` entries are loose
 * objects too — only `ticker` is typed; `sentiment` and anything else the
 * vendor adds ride through verbatim to be parsed defensively at render.
 */
export const newsResultSchema = z.looseObject({
  id: z.string().optional(),
  publisher: newsPublisherSchema.optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  /** ISO-8601 Z, e.g. '2026-08-16T06:30:00Z' — a timestamp, not money. */
  published_utc: z.string().optional(),
  article_url: z.string().optional(),
  tickers: z.array(z.string()).optional(),
  image_url: z.string().optional(),
  /** The vendor's AI summary — the whole of the body text on this API. */
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  insights: z.array(z.looseObject({ ticker: z.string().optional() })).optional(),
});

export type NewsResult = z.infer<typeof newsResultSchema>;

export const newsResponseSchema = z.looseObject({
  results: z.array(newsResultSchema).optional(),
  next_url: z.string().optional(),
});

/** One mapped article — the store's insert shape. */
export interface NewsArticle {
  id: string;
  title: string;
  articleUrl: string;
  /** Epoch ms parsed from `published_utc` — results that do not parse are dropped. */
  publishedAtMs: number;
  author: string | null;
  publisherName: string | null;
  publisherHomepage: string | null;
  /**
   * Publisher logo/favicon URLs, stored VERBATIM (nullable). The proxy route
   * (`/api/news/publisher-logo/[id]`) enforces origin + scheme + content-type
   * at fetch time — deliberately not here, so a change of gate never needs a
   * re-fetch of immutable rows. The URLs never reach a client.
   */
  publisherLogoUrl: string | null;
  publisherFaviconUrl: string | null;
  imageUrl: string | null;
  description: string | null;
  /** Uppercased, deduped vendor ticker tags — the join-table rows. */
  tickers: string[];
  /** Vendor arrays verbatim (loosely validated) — persisted as jsonb. */
  keywords: unknown;
  insights: unknown;
}

/**
 * Query for one news fetch — ONE symbol per request, never a list. Pure like
 * `snapshotParams` so the request shape is unit-testable — though a hermetic
 * test proves only that the params are included, never that the vendor
 * accepts them. Verified live 2026-08-16: `ticker` (single symbol) + `limit`
 * are the two params the vendor actually honors; `ticker.any_of`, `tickers`
 * and `ticker.in` are all SILENTLY IGNORED (global newest with `status: OK`),
 * and a comma list on `ticker` returns 0 results — so any future "batching"
 * of symbols into one request silently empties the feed.
 */
export function newsParams(symbol: string, limit: number): URLSearchParams {
  return new URLSearchParams({
    ticker: symbol,
    limit: String(limit),
  });
}

/**
 * News results → `NewsArticle[]`. A result missing any of the four identity
 * fields (`id`, `title`, `article_url`, `published_utc`) — or whose timestamp
 * does not parse — is DROPPED, never thrown: one malformed story must not
 * blank the feed. Everything else is optional and defaults to null/empty.
 *
 * `article_url` must additionally be `https://`, the same gate the image proxy
 * applies to `image_url`. It is the one URL the user actually clicks, it is
 * rendered straight into an `href`, and the row is immutable once written — so
 * a poisoned `javascript:`/`data:` URL would outlive the bad response by 90
 * days. React only warns on such hrefs; it does not reliably block them.
 */
export function mapNewsResults(items: readonly NewsResult[]): NewsArticle[] {
  const articles: NewsArticle[] = [];
  for (const item of items) {
    if (!item.id || !item.title || !item.article_url || !item.published_utc) continue;
    if (!item.article_url.startsWith('https://')) continue;
    // A timestamp, not money — Date.parse is sanctioned here.
    const publishedAtMs = Date.parse(item.published_utc);
    if (!Number.isFinite(publishedAtMs)) continue;

    const tickers = [...new Set((item.tickers ?? []).map((t) => t.toUpperCase()))];

    articles.push({
      id: item.id,
      title: item.title,
      articleUrl: item.article_url,
      publishedAtMs,
      author: item.author ?? null,
      publisherName: item.publisher?.name ?? null,
      publisherHomepage: item.publisher?.homepage_url ?? null,
      publisherLogoUrl: item.publisher?.logo_url ?? null,
      publisherFaviconUrl: item.publisher?.favicon_url ?? null,
      imageUrl: item.image_url ?? null,
      description: item.description ?? null,
      tickers,
      keywords: item.keywords ?? null,
      insights: item.insights ?? null,
    });
  }
  return articles;
}
