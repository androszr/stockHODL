import {
  signedMoney,
  type LiveFigure,
  type LiveMarket,
  type LiveSummary,
} from '@/lib/holdings/live-payload';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import type { OptionQuoteOutcome } from '@/lib/market-data/options-types';
import type { Candle, MarketSessionInfo } from '@/lib/market-data/provider';
import {
  ZERO,
  dec,
  directionOf,
  fmtMoney,
  fmtDecimal,
  fmtPct,
  fmtQuantity,
  pctChange,
  toNumeric,
  type Direction,
  type Money,
} from '@/lib/money';
import type { TrendSlot } from '@/lib/trend/day-trend';

import { aggregateOptionLots } from './aggregate-lots';
import {
  resolveOptionPrints,
  type PreviousMark,
  type ResolvedPrint,
} from './fresh-print';
import { markOptionQuotes } from './option-mark';
import { utcNoonMs } from './ny-dates';

/**
 * Pure payload composition for the Options tab — isomorphic like
 * `watchlist-payload.ts`: no `server-only`, no DB, no fetch. Every money
 * figure is a pre-formatted display string built through `dec()` /
 * `fmtMoney` / `fmtPct` / `directionOf`; Decimal never crosses the client
 * boundary. Everything is USD, deliberately (interview decision): these
 * contracts trade in dollars and the tab stays outside the złoty portfolio
 * totals — no FX column, no NBP lookup, no fake comparability.
 *
 * An absent figure renders an em-dash, NEVER `'0'`: a thinly traded
 * contract legitimately has no greeks, no IV, sometimes no price at all,
 * and a fake zero would read as a fact.
 */

/** One tracked lot, exactly as `option_positions` returns it (numerics as strings). */
export interface OptionPositionRow {
  id: string;
  ticker: string;
  underlying: string;
  contractType: 'call' | 'put';
  strikePrice: string;
  /** 'YYYY-MM-DD'. */
  expirationDate: string;
  sharesPerContract: string;
  quantity: string;
  entryPrice: string;
  /** 'YYYY-MM-DD'. */
  tradeDate: string;
  /** Total lot costs in USD (commission + exchange fee, summed). */
  fees: string;
}

/**
 * One MEMBER lot of a card, formatted for the `⋯` menu plus the raw strings
 * the edit form prefills from. A card can stand for several
 * `option_positions` rows, so every mutation addresses a LOT, never the card:
 * this is what keeps each purchase reachable and un-mutable-by-proxy.
 */
export interface OptionLotItem {
  /** The `option_positions` row id — what Edit/Remove address. */
  id: string;
  /** `fmtQuantity`. */
  quantity: string;
  /** `fmtMoney(_, 'USD')`. */
  entryPrice: string;
  /** Formatted costs, null on zero — the existing convention. */
  fees: string | null;
  /** pl-PL compact, e.g. `12 sie` — the menu label. */
  tradeDateLabel: string;
  /** Raw decimal strings + ISO date: the edit form's prefill. */
  tradeDate: string;
  quantityRaw: string;
  entryPriceRaw: string;
  feesRaw: string;
}

/** One card's fully formatted display state — strings only. */
export interface OptionCardItem {
  /**
   * The CARD's identity (the OCC ticker, or `ticker#rowId` for a degenerate
   * group) — React keys, DOM ids and the sort's final tiebreak. Deliberately
   * not a row id: a card can stand for several rows.
   */
  key: string;
  ticker: string;
  underlying: string;
  contractType: 'call' | 'put';
  /** Compact strike for the headline, e.g. `220` — no trailing zeros. */
  strikeLabel: string;
  /** Full formatted strike for the detail row. */
  strike: string;
  /** 'YYYY-MM-DD' — kept for stable keys/aria. */
  expirationDate: string;
  /** Human date, e.g. `4 wrz 2026`. */
  expiryLabel: string;
  /** NY-calendar days until expiry — can be negative once expired. */
  daysToExpiry: number;
  expired: boolean;
  /** Σ over the member lots. */
  quantity: string;
  /** The quantity-WEIGHTED average entry when `entryIsAverage`; the lot's own
   *  stored entry otherwise. Formatted — the unrounded average never leaves. */
  entryPrice: string;
  /**
   * Formatted total costs, e.g. `2,04 USD` — null when the summed value is
   * zero, so a fee-less lot renders no costs line and no caption. The card's
   * "after costs" P/L caption keys off this being non-null.
   */
  fees: string | null;
  /**
   * Σ per lot of entry × quantity × sharesPerContract + fees, formatted USD.
   * Always emitted — the phone's optional decode is only for deploy skew.
   */
  totalCost: string;
  /**
   * The member lots, oldest trade date first. Every mutation goes through
   * one of these — the card carries NO row id, no `tradeDate` and no raw
   * quantity/entry/fees of its own, because on an aggregate those would be a
   * sum and an average, i.e. values no edit may ever submit. Their absence
   * makes prefilling an edit form with an average a type error.
   */
  lots: OptionLotItem[];
  /** `lots.length` — one number for the copy that names it. */
  lotCount: number;
  /** `lots.length > 1`: the entry price above is an average and says so. */
  entryIsAverage: boolean;
  /** Live figures — null together with `hasQuote === false`. */
  hasQuote: boolean;
  price: string | null;
  /**
   * The price is a MODEL ESTIMATE (Black-Scholes on the vendor's own implied
   * volatility), not a traded price. Every surface that renders the price must
   * label it — the label is the mitigation for pricing off a model, and it is
   * not optional.
   */
  priceIsEstimate: boolean;
  /**
   * Pre-worded basis for an estimate's day figure, e.g. `vs estimate of
   * 14 sie` — null when there is no day figure or the price is not an
   * estimate. A mark's move is measured against the previous EVENING'S mark,
   * never against a traded close.
   */
  dayBasisLabel: string | null;
  /**
   * When the contract last actually traded, pl-PL compact (e.g. `13 sie`) —
   * dated by the daily bars (a bar exists iff prints exist). Null when no
   * bars arrived; the caption then stays absent rather than guessing.
   */
  lastTradeLabel: string | null;
  /**
   * The lookback window came back EMPTY — the contract has been silent longer
   * than it covers, so no date is claimable. Each surface words this its own
   * way (the card and the dashboard tile prefix the label differently), which
   * is why this is a flag and not a pre-worded string.
   */
  lastTradeBeyondLookback: boolean;
  /** Bars PROVED the contract did not trade in the session a day figure
   *  would describe — the card says so instead of a fake flat 0,00%. */
  noTrade: boolean;
  day: LiveFigure | null;
  /** Percent-only twin of `day` for the Dashboard tile. */
  dayPct: LiveFigure | null;
  /**
   * The five-session strip, oldest first, holes included — drawn along the
   * bottom of the Dashboard tile. Absent when nothing could be graded at all.
   *
   * Graded on `OPTION_TREND_SCALE`, not the equity bands: an option premium
   * moving 3% has had a dull session, so equity thresholds would peg every
   * bar at full height and the row would say nothing.
   */
  trend?: TrendSlot[];
  pl: LiveFigure | null;
  /** Per-share P/L percent alone (tile line) — '—' when unpriceable. */
  plPct: string;
  /** Direction of the net P/L amount; neutral when unpriceable. */
  plDirection: Direction;
  /** Unformatted decimal-string twin of the P/L amount; never rendered. */
  plRaw: string | null;
  /**
   * Unformatted decimal-string TOTAL lot value (price × quantity ×
   * sharesPerContract) — a SORT KEY only, never rendered (the `plRaw`
   * precedent): it carries up to 8 dp from `toNumeric`, so putting it on
   * screen would be an unformatted figure. Null iff `hasQuote` is false —
   * unknown, never a zero.
   */
  valueRaw: string | null;
  breakEven: string;
  delta: string;
  gamma: string;
  theta: string;
  vega: string;
  impliedVolatility: string;
  openInterest: string;
}

/**
 * The loader's bundle, structurally — `LoadedOptions` from the (server-only)
 * `live-view.ts` satisfies it exactly. Declared here so this module stays
 * isomorphic and unit-testable while the three live surfaces pass the loader's
 * output straight through.
 */
export interface LoadedOptionsInputs {
  rows: readonly OptionPositionRow[];
  quotes: ReadonlyMap<string, OptionQuoteOutcome>;
  bars: ReadonlyMap<string, readonly Candle[]>;
  spots: ReadonlyMap<string, string>;
  /** ≤2 per ticker, newest first — see `LoadedOptions.recentMarks`. */
  recentMarks: ReadonlyMap<string, readonly PreviousMark[]>;
  /** OCC ticker to its trend strip - see `LoadedOptions.trends`. */
  trends?: ReadonlyMap<string, TrendSlot[]>;
  /** The UNEXPIRED book's summed strip, USD — the "Options" total's lights. */
  summaryTrend?: TrendSlot[];
  market: MarketSessionInfo;
}

export interface OptionsPayload {
  market: LiveMarket;
  items: OptionCardItem[];
  /**
   * The VISIBLE total: USD-only (deliberately non-comparable with the złoty
   * portfolio totals) and over UNEXPIRED lots only, because expired contracts
   * are hidden by default. The summary and the list it describes always cover
   * the same set — a hidden lot never sits inside a shown total.
   */
  summary: LiveSummary;
  /** Extra caveat lines under the summary (stale-print note) — `[]` when none. */
  summaryNotes: string[];
  /** The same figures over EVERY lot — shown while expired ones are revealed. */
  allSummary: LiveSummary;
  /** `allSummary`'s notes, led by the expired-inclusion line when relevant. */
  allSummaryNotes: string[];
  /** How many tracked lots are expired — drives the "N expired — show" toggle. */
  expiredCount: number;
}

const DASH = '—';
const LOCALE = 'pl-PL';
const MS_PER_DAY = 86_400_000;


const EXPIRY_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Compact `13 sie` form for the last-traded caption and the stale-print note. */
const LAST_TRADE_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
});

/**
 * Caption for a contract silent longer than the bar lookback window. No date
 * is claimable — the window came back empty — so the words say exactly that
 * much and no more. Deliberately vaguer than a date, because a precise-looking
 * date we cannot source would be the same fake-confidence sin as a flat 0,00%.
 */
const BEYOND_LOOKBACK_LABEL = 'over a month ago';

/** `13 sie` from a 'YYYY-MM-DD' — UTC noon, never the device midnight. */
function fmtBasisDate(dateISO: string): string {
  return LAST_TRADE_FORMAT.format(new Date(utcNoonMs(dateISO)));
}

/**
 * The small print beside an estimate's day figure, naming what it is measured
 * from — and, while the market is shut, what it is measured TO.
 *
 * While a session runs the tip is the live mark shown as the price above, so
 * naming the base alone is complete: `vs estimate of 14 sie`.
 *
 * While the market is shut the figure describes the last completed session —
 * two RECORDED evenings — and is NOT measured from the price above it. Both
 * ends are named (`estimate 13 sie → 14 sie`) precisely so the number can
 * never be read as the move from that price.
 *
 */
function dayBasisLabelFor(baseISO: string, tipISO: string | null | undefined): string {
  const base = fmtBasisDate(baseISO);
  return tipISO ? `estimate ${base} → ${fmtBasisDate(tipISO)}` : `vs estimate of ${base}`;
}

/**
 * The compact `NET $370C` identity — the summary's excluded/stale naming and
 * the series' exclusion list share it, so a lot is named the same way
 * everywhere.
 */
export function compactOptionLabel(
  lot: Pick<OptionPositionRow, 'underlying' | 'strikePrice' | 'contractType'>,
): string {
  const suffix = lot.contractType === 'call' ? 'C' : 'P';
  return `${lot.underlying} $${fmtDecimal(dec(lot.strikePrice), 0, 4)}${suffix}`;
}

/** Greeks are unitless sensitivities, not money — `fmtDecimal` is money.ts's
 *  display-only crossing, shared so this module does no float conversion. */
function fmtGreek(value: string | null): string {
  if (value === null) return DASH;
  return fmtDecimal(dec(value), 2, 4);
}

/** IV arrives as a decimal fraction (0.29 = 29%); unsigned by design — it is
 *  a level, not a change, so `fmtPct`'s '+' would mislead. */
function fmtImpliedVolatility(value: string | null): string {
  if (value === null) return DASH;
  return `${fmtDecimal(dec(value).times(100), 2, 2)}%`;
}

/** An integer count — plain-number formatting is sanctioned. */
function fmtOpenInterest(value: number | null): string {
  if (value === null) return DASH;
  return new Intl.NumberFormat(LOCALE, {
    maximumFractionDigits: 0,
    useGrouping: 'always',
  }).format(value);
}

/**
 * The one-call form every LIVE surface uses (page, poll route, dashboard):
 * one clock read feeds both the resolver and the compose, so the described
 * session and the days-to-expiry can never disagree. Kept out of the server
 * COMPONENTS themselves because the react-hooks purity rule (correctly)
 * forbids a bare `Date.now()` in a component body.
 */
export function composeLiveOptionsPayload(loaded: LoadedOptionsInputs): OptionsPayload {
  const nowMs = Date.now();
  // The model marks are computed PER REQUEST and never persisted here — only
  // the nightly run records (plan decision). `markOptionQuotes` is the single
  // float boundary; what comes back is an ordinary decimal string per ticker.
  const marks = markOptionQuotes(loaded.quotes, loaded.spots, nowMs);
  return composeOptionsPayload(
    loaded.rows,
    loaded.quotes,
    loaded.market,
    nowMs,
    resolveOptionPrints(
      loaded.quotes,
      loaded.bars,
      loaded.market,
      nowMs,
      marks,
      loaded.recentMarks,
    ),
    loaded.trends,
    loaded.summaryTrend,
  );
}

/** No-bars fallback for a print the resolver did not cover (defensive — the
 *  default resolver run below covers every quoted ticker). */
function fallbackPrint(price: string | null): ResolvedPrint {
  return {
    price,
    source: 'snapshot',
    lastTradeDateISO: null,
    day: null,
    noTradeThisSession: false,
    staleBeyondLookback: false,
  };
}

const NO_BARS: ReadonlyMap<string, never[]> = new Map();

/**
 * One member row → its menu entry plus the edit form's prefill. Formatted
 * ONCE, from the row's own STORED strings — never from the card's average or
 * its sums, which is exactly the value an edit must never submit.
 */
function lotItem(lot: OptionPositionRow): OptionLotItem {
  const lotFees = dec(lot.fees);
  return {
    id: lot.id,
    quantity: fmtQuantity(dec(lot.quantity)),
    entryPrice: fmtMoney(dec(lot.entryPrice), 'USD'),
    fees: lotFees.isZero() ? null : fmtMoney(lotFees, 'USD'),
    tradeDateLabel: LAST_TRADE_FORMAT.format(new Date(utcNoonMs(lot.tradeDate))),
    tradeDate: lot.tradeDate,
    // `dec().toString()` trims storage zeros ('2.00000000' → '2') — still a
    // decimal string end-to-end, never a float. These prefill the edit form.
    quantityRaw: dec(lot.quantity).toString(),
    entryPriceRaw: dec(lot.entryPrice).toString(),
    feesRaw: lotFees.toString(),
  };
}

/**
 * Rows + live outcomes + market status → the serializable Options payload.
 * One item per CONTRACT (2026-08-15): `aggregateOptionLots` merges two
 * purchases of the same OCC ticker into one card with the combined size, the
 * quantity-weighted average entry and the summed costs, so every figure below
 * — break-even, P/L, value — is recomputed for the aggregate and none is
 * inherited from a member.
 *
 * The QUOTE RULE that makes this safe: the group key IS the ticker and
 * `quotes` is keyed by ticker (`live-view.ts`), so every member of an
 * aggregate shares one quote outcome — a partially-quoted aggregate cannot
 * exist. An aggregate is unquoted iff its ticker is, and it then renders the
 * same em-dashes, the same "No quote yet" note, and is excluded from the
 * summary by label exactly as a single lot was.
 *
 * `nowMs` is injectable for tests; the
 * "today" every days-to-expiry figure measures from is the NY calendar date
 * (`nyDateISOAt`) — never the device timezone, so a Warsaw evening cannot
 * show one day too few.
 *
 * `prints` is the freshest-print resolver's output (2026-08-15): the price,
 * the P/L and the day figure all read the RESOLVED print, never the raw
 * snapshot. Callers with bars run `resolveOptionPrints` and pass the result;
 * when omitted, the resolver runs here over an empty bars map — same rules
 * (including the degenerate-0.00% suppression), just nothing to out-vote a
 * stale snapshot with.
 */
export function composeOptionsPayload(
  rows: readonly OptionPositionRow[],
  quotes: ReadonlyMap<string, OptionQuoteOutcome>,
  market: MarketSessionInfo,
  nowMs: number = Date.now(),
  prints?: ReadonlyMap<string, ResolvedPrint>,
  trends?: ReadonlyMap<string, TrendSlot[]>,
  summaryTrend?: TrendSlot[],
): OptionsPayload {
  const todayISO = nyDateISOAt(nowMs);
  const todayNoonMs = utcNoonMs(todayISO);
  const resolvedPrints = prints ?? resolveOptionPrints(quotes, NO_BARS, market, nowMs);

  // One contribution per AGGREGATE, in first-appearance order — the summary
  // is computed from these TWICE (unexpired only, and all), so a hidden
  // contract can never sit inside a total unremarked. Value, basis, P/L and
  // the day amount are all LINEAR in quantity, so merging lots regroups the
  // contributions without moving a single total.
  const contribs = composeOptionLotContributions(
    { rows, quotes, market, prints: resolvedPrints },
    nowMs,
  );

  const items = aggregateOptionLots(rows).map((row): OptionCardItem => {
    const outcome = quotes.get(row.ticker);
    const quote = outcome?.ok ? outcome.quote : undefined;
    const print =
      resolvedPrints.get(row.ticker) ?? fallbackPrint(quote ? quote.price : null);

    const entry = dec(row.entryPrice);
    const strike = dec(row.strikePrice);
    const fees = dec(row.fees);
    const totalCostDec = row.lots.reduce(
      (acc, lot) =>
        acc
          .plus(
            dec(lot.entryPrice)
              .times(dec(lot.quantity))
              .times(dec(lot.sharesPerContract)),
          )
          .plus(dec(lot.fees)),
      ZERO,
    );

    // Break-even at expiry, from the USER'S OWN entry price — well-defined
    // because every tracked lot carries one (decision in the plan): the
    // underlying must reach strike + premium (calls) / strike − premium
    // (puts) for the position to break even at expiry.
    const breakEvenDec =
      row.contractType === 'call' ? strike.plus(entry) : strike.minus(entry);

    // The RESOLVED print is the one price everything below speaks for: the
    // headline, the P/L and the day pair — one source, coherently (a
    // bar-sourced price never renders beside a snapshot-sourced pair; the
    // resolver enforces it). Non-null iff a quote arrived.
    const priceRaw = quote ? print.price : null;

    // A model mark prices this lot. Tracked per LOT (two lots of one contract
    // share the source), and only ever true beside an actual price.
    const priceIsEstimate = priceRaw !== null && print.source === 'model';

    // Day pair — atomic upstream (deriveDayPair / the resolver): both halves
    // or neither. Null covers "no pair" AND "bars proved no trade" — the
    // card renders the noTrade case in words, never a fake flat 0,00%.
    const day: LiveFigure | null = print.day
      ? {
          text: `${signedMoney(dec(print.day.amt), 'USD')} (${fmtPct(dec(print.day.pct))})`,
          direction: directionOf(dec(print.day.amt)),
        }
      : null;
    const dayPct: LiveFigure | null = print.day
      ? {
          text: fmtPct(dec(print.day.pct)),
          direction: directionOf(dec(print.day.amt)),
        }
      : null;

    // P/L: (price − entry) × quantity × sharesPerContract − fees, all
    // Decimal — the AMOUNT is net of the lot's recorded costs (decision,
    // screenshot-import plan). Percent stays per-share vs entry (`pctChange`
    // — null on a zero entry, never a division crash, never +0.00%): a
    // lot-level cost mixed into a per-share percent would be neither figure.
    // ISO dates order lexicographically — the expiry DAY itself is not
    // expired. Computed before the accumulation so a contribution carries it.
    const expired = row.expirationDate < todayISO;

    let pl: LiveFigure | null = null;
    let plRaw: string | null = null;
    let valueRaw: string | null = null;
    let plPctText: string = DASH;
    let plDirection: Direction = 'neutral';
    if (priceRaw !== null) {
      const priceDec = dec(priceRaw);
      const plDec = priceDec
        .minus(entry)
        .times(dec(row.quantity))
        .times(dec(row.sharesPerContract))
        .minus(fees);
      const plPct = pctChange(entry, priceDec);
      pl = {
        text:
          plPct === null
            ? signedMoney(plDec, 'USD')
            : `${signedMoney(plDec, 'USD')} (${fmtPct(plPct)})`,
        direction: directionOf(plDec),
      };
      plRaw = toNumeric(plDec);
      plPctText = fmtPct(plPct);
      plDirection = directionOf(plDec);

      const valueDec = priceDec.times(dec(row.quantity)).times(dec(row.sharesPerContract));
      // Sort key only — never rendered (see the field's doc comment).
      valueRaw = toNumeric(valueDec);
    }

    // Calendar-day difference at UTC noon — a count, never money.
    const daysToExpiry = Math.round(
      (utcNoonMs(row.expirationDate) - todayNoonMs) / MS_PER_DAY,
    );

    return {
      key: row.key,
      ticker: row.ticker,
      underlying: row.underlying,
      contractType: row.contractType,
      // Locale-formatted like every other figure on the card — `toString()`
      // would print `222.5` beside `223,50 USD` and read as a rendering bug.
      strikeLabel: fmtDecimal(strike, 0, 4),
      strike: fmtMoney(strike, 'USD'),
      expirationDate: row.expirationDate,
      expiryLabel: EXPIRY_FORMAT.format(new Date(utcNoonMs(row.expirationDate))),
      daysToExpiry,
      expired,
      quantity: fmtQuantity(dec(row.quantity)),
      entryPrice: fmtMoney(entry, 'USD'),
      // Null on zero — a fee-less lot renders no costs line, no caption.
      fees: fees.isZero() ? null : fmtMoney(fees, 'USD'),
      totalCost: fmtMoney(totalCostDec, 'USD'),
      lots: row.lots.map(lotItem),
      lotCount: row.lots.length,
      entryIsAverage: row.lots.length > 1,
      hasQuote: quote !== undefined,
      price: priceRaw !== null ? fmtMoney(dec(priceRaw), 'USD') : null,
      priceIsEstimate,
      dayBasisLabel:
        priceIsEstimate && print.dayBasisMarkDateISO
          ? dayBasisLabelFor(print.dayBasisMarkDateISO, print.dayBasisTipDateISO)
          : null,
      lastTradeLabel:
        print.lastTradeDateISO !== null
          ? LAST_TRADE_FORMAT.format(new Date(utcNoonMs(print.lastTradeDateISO)))
          : null,
      lastTradeBeyondLookback: print.staleBeyondLookback,
      noTrade: print.noTradeThisSession,
      day,
      dayPct,
      trend: trends?.get(row.ticker),
      pl,
      plPct: plPctText,
      plDirection,
      plRaw,
      valueRaw,
      breakEven: fmtMoney(breakEvenDec, 'USD'),
      delta: fmtGreek(quote?.greeks.delta ?? null),
      gamma: fmtGreek(quote?.greeks.gamma ?? null),
      theta: fmtGreek(quote?.greeks.theta ?? null),
      vega: fmtGreek(quote?.greeks.vega ?? null),
      impliedVolatility: fmtImpliedVolatility(quote?.impliedVolatility ?? null),
      openInterest: fmtOpenInterest(quote?.openInterest ?? null),
    };
  });

  // TWO summaries over the SAME contributions: the default one describes only
  // what the tab shows (expired contracts hidden), and `allSummary` describes
  // every tracked lot for when the user reveals them. The client picks one and
  // switches the list with it in the same render — a hidden lot inside a
  // visible total is exactly the fake confidence this split exists to prevent.
  const unexpired = contribs.filter((c) => !c.expired);
  // Counts expired CARDS, not expired LOTS — deliberate. It drives the
  // "N expired — show" toggle, and the toggle reveals cards, so the number
  // must match what appears when it is tapped. Two lots of one expired
  // contract are one hidden card and therefore count once. (The pre-merge
  // behaviour counted lots; noted by the bug audit so the change is a
  // decision, not a side effect.)
  const expiredCount = contribs.length - unexpired.length;
  const visible = summarizeOptionLots(unexpired);
  const all = summarizeOptionLots(contribs);

  const allSummaryNotes =
    expiredCount > 0 ? [EXPIRED_INCLUDED_NOTE, ...all.notes] : all.notes;

  return {
    market: { ...market, serverNowMs: Date.now() },
    items,
    // The strip is graded over the unexpired book (the loader's set), which
    // is the set `summary` describes; `allSummary` deliberately carries none.
    summary: { ...visible.summary, trend: summaryTrend },
    summaryNotes: visible.notes,
    allSummary: all.summary,
    allSummaryNotes,
    expiredCount,
  };
}

/**
 * One lot's contribution to a summary — Decimal, USD, never serialized. A
 * `null` `valueDec` means the lot had NO quote: it is excluded from value,
 * basis and P/L entirely and named in `excludedSymbols`, never counted as
 * zero.
 */
export interface OptionLotContribution {
  ticker: string;
  groupKey: string;
  expirationDate: string;
  expired: boolean;
  /** The compact `NET $370C` identity — one naming everywhere. */
  label: string;
  valueDec: Money | null;
  basisDec: Money | null;
  plDec: Money | null;
  /** Lot-level day amount; null when no day pair is rendered for the lot. */
  dayAmtDec: Money | null;
  /** The day pair's own base value — the summary percent's denominator.
   *  Null exactly when `dayAmtDec` is. */
  dayBaseValueDec: Money | null;
  priceIsEstimate: boolean;
  /** Pre-worded stale-print entry (with its date), or null. */
  staleNote: string | null;
}

export interface OptionContributionInputs {
  rows: readonly OptionPositionRow[];
  quotes: ReadonlyMap<string, OptionQuoteOutcome>;
  market: MarketSessionInfo;
  prints?: ReadonlyMap<string, ResolvedPrint>;
}

/** The one Decimal contribution body shared by Options and Day report. */
export function composeOptionLotContributions(
  loaded: OptionContributionInputs,
  nowMs: number = Date.now(),
): OptionLotContribution[] {
  const todayISO = nyDateISOAt(nowMs);
  const resolvedPrints =
    loaded.prints ?? resolveOptionPrints(loaded.quotes, NO_BARS, loaded.market, nowMs);

  return aggregateOptionLots(loaded.rows).map((row) => {
    const outcome = loaded.quotes.get(row.ticker);
    const quote = outcome?.ok ? outcome.quote : undefined;
    const print = resolvedPrints.get(row.ticker) ?? fallbackPrint(quote ? quote.price : null);
    const label = compactOptionLabel(row);
    const expired = row.expirationDate < todayISO;
    const priceRaw = quote ? print.price : null;
    if (priceRaw === null) {
      return {
        ticker: row.ticker,
        groupKey: row.key,
        expirationDate: row.expirationDate,
        expired,
        label,
        valueDec: null,
        basisDec: null,
        plDec: null,
        dayAmtDec: null,
        dayBaseValueDec: null,
        priceIsEstimate: false,
        staleNote: null,
      };
    }

    const priceDec = dec(priceRaw);
    const quantity = dec(row.quantity).times(dec(row.sharesPerContract));
    const entry = dec(row.entryPrice);
    const fees = dec(row.fees);
    const valueDec = priceDec.times(quantity);
    const priceIsEstimate = print.source === 'model';
    let staleNote: string | null = null;
    if (print.noTradeThisSession && !priceIsEstimate) {
      staleNote = print.staleBeyondLookback
        ? `${label} (${BEYOND_LOOKBACK_LABEL})`
        : print.lastTradeDateISO !== null
          ? `${label} (${LAST_TRADE_FORMAT.format(new Date(utcNoonMs(print.lastTradeDateISO)))})`
          : label;
    }
    const dayAmtDec = print.day ? dec(print.day.amt).times(quantity) : null;
    return {
      ticker: row.ticker,
      groupKey: row.key,
      expirationDate: row.expirationDate,
      expired,
      label,
      valueDec,
      basisDec: entry.times(quantity).plus(fees),
      plDec: priceDec.minus(entry).times(quantity).minus(fees),
      dayAmtDec,
      dayBaseValueDec:
        print.day === null
          ? null
          : print.dayBasisBaseMark != null
            ? dec(print.dayBasisBaseMark).times(quantity)
            : valueDec.minus(dayAmtDec ?? ZERO),
      priceIsEstimate,
      staleNote,
    };
  });
}

export function dayReportOptionLabel(lot: {
  underlying: string;
  strikePrice: string;
  contractType: 'call' | 'put';
  expirationDate: string;
}): string {
  const [year, month] = lot.expirationDate.split('-');
  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, Number(month) - 1, 1)),
  );
  return `${compactOptionLabel(lot)} ${monthLabel}${year.slice(-2)}`;
}

/** The larger total always says why it is larger. */
const EXPIRED_INCLUDED_NOTE = 'Includes expired contracts.';

/**
 * Contributions → the USD summary and its caveat lines. Pure, and called
 * TWICE (unexpired / all) — which is the whole reason it is extracted; the
 * logic itself is a verbatim relocation of the pre-2026-08-15 accumulation.
 *
 * `LiveSummary`'s exact shape, so `PortfolioSummary` renders it unchanged.
 * Null figures with zero quoted lots ('—', never a fake $0); value and basis
 * always cover the SAME quoted set (no mixed-set percent); the day pct derives
 * on the covered subset only and says so when that subset is partial.
 */
export function summarizeOptionLots(contribs: readonly OptionLotContribution[]): {
  summary: LiveSummary;
  notes: string[];
} {
  let quotedValue = ZERO;
  let quotedBasis = ZERO;
  let quotedCount = 0;
  let plSum = ZERO;
  let dayAmtSum = ZERO;
  let dayBaseValue = ZERO;
  let dayCoveredValue = ZERO;
  let dayCoveredCount = 0;
  let anyQuotedWithoutDay = false;
  const excludedSymbols: string[] = [];
  const stalePrints: string[] = [];
  // Estimate bookkeeping: whether ANY lot is model-priced (one note), and
  // which QUOTED lots are not (named, so a fallback is never silent).
  let anyEstimated = false;
  const lastTradePriced: string[] = [];

  for (const c of contribs) {
    if (c.valueDec === null || c.basisDec === null || c.plDec === null) {
      if (!excludedSymbols.includes(c.label)) excludedSymbols.push(c.label);
      continue;
    }
    quotedValue = quotedValue.plus(c.valueDec);
    quotedBasis = quotedBasis.plus(c.basisDec);
    plSum = plSum.plus(c.plDec);
    quotedCount += 1;
    if (c.dayAmtDec !== null) {
      dayAmtSum = dayAmtSum.plus(c.dayAmtDec);
      dayBaseValue = dayBaseValue.plus(c.dayBaseValueDec ?? c.valueDec.minus(c.dayAmtDec));
      dayCoveredValue = dayCoveredValue.plus(c.valueDec);
      dayCoveredCount += 1;
    } else {
      anyQuotedWithoutDay = true;
    }
    if (c.priceIsEstimate) {
      anyEstimated = true;
    } else if (!lastTradePriced.includes(c.label)) {
      // A QUOTED lot with no estimate keeps exactly today's behaviour — and
      // is named, so the reader knows which figures came from a last trade.
      lastTradePriced.push(c.label);
    }
    if (c.staleNote !== null && !stalePrints.includes(c.staleNote)) {
      stalePrints.push(c.staleNote);
    }
  }

  const totalPct = pctChange(quotedBasis, quotedValue);
  // Measured on the pair's own two ends, so the percent always describes the
  // same move as the amount beside it and can never disagree in sign with it.
  const dayPctDec = pctChange(dayBaseValue, dayBaseValue.plus(dayAmtSum));
  const summary: LiveSummary = {
    totalValue: quotedCount === 0 ? null : fmtMoney(quotedValue, 'USD'),
    dayChange:
      dayCoveredCount === 0
        ? null
        : {
            text:
              dayPctDec === null
                ? signedMoney(dayAmtSum, 'USD')
                : `${signedMoney(dayAmtSum, 'USD')} (${fmtPct(dayPctDec)})`,
            direction: directionOf(dayAmtSum),
          },
    totalChange:
      quotedCount === 0
        ? null
        : {
            text:
              totalPct === null
                ? signedMoney(plSum, 'USD')
                : `${signedMoney(plSum, 'USD')} (${fmtPct(totalPct)})`,
            direction: directionOf(plSum),
          },
    // Same two Decimals, same `fmtPct`, one line up from the strings that
    // embed them — see the note on `LiveSummary`.
    dayChangePct: dayCoveredCount === 0 || dayPctDec === null ? null : fmtPct(dayPctDec),
    totalChangePct: quotedCount === 0 || totalPct === null ? null : fmtPct(totalPct),
    excludedSymbols,
    partialDayChange: anyQuotedWithoutDay,
  };

  // The caveat lines, in a fixed order: what the figures ARE, then which lots
  // they are not, then the surviving stale-print disclosure.
  const notes: string[] = [];
  if (anyEstimated) {
    notes.push(
      "Value and P/L use model estimates (from the market's implied volatility), not last traded prices.",
    );
  }
  // The fallback note is a MIXED-SOURCE disclosure: it exists so a reader who
  // has been told the figures are estimates learns which ones are not. With
  // nothing estimated at all (no marks anywhere — a vendor outage, or every
  // contract failing a gate) the tab is exactly the pre-2026-08-15 tab and
  // says so by saying nothing, rather than captioning every lot with the
  // absence of a feature.
  if (anyEstimated && lastTradePriced.length > 0) {
    notes.push(
      `Priced from the last trade, no estimate available: ${lastTradePriced.join(', ')}`,
    );
  }
  if (stalePrints.length > 0) {
    notes.push(`Includes last prints from earlier sessions: ${stalePrints.join(', ')}`);
  }

  return { summary, notes };
}
