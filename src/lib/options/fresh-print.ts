import { deriveDayPair } from '@/lib/market-data/massive-mapping';
import { lastCompletedSessionDateISO, nyDateISOAt } from '@/lib/market-data/market-clock';
import type { OptionQuoteOutcome } from '@/lib/market-data/options-types';
import type { Candle, MarketSessionInfo } from '@/lib/market-data/provider';
import { dec } from '@/lib/money';
import { calendarDaysBetween } from './ny-dates';

/**
 * The freshest-print resolver — pure and isomorphic (no I/O; bars arrive from
 * `close-sync.ts`, quotes from the snapshot batch). Why it exists, verified
 * live 2026-08-15: the unified snapshot can LAG the daily aggregates on
 * illiquid contracts — `O:ACME270319C00260000` returned `session.close =
 * previous_close = 13.07` (a fake flat 0.00%) while its daily bars showed
 * 08-13 → 13.07 and 08-14 → 12.10.
 *
 * THE STALENESS SIGNATURE (revised 2026-08-15 after review): a snapshot is
 * treated as stale iff its OWN day pair is DEGENERATE — `session.close ==
 * session.previous_close`, Decimal equality. That is the signature the stale
 * ACME contract exhibits (13.07 / 13.07) and fresh contracts do NOT
 * (`O:ZORA270319C00095000` → 3.90 / 3.05, `O:IDXF261218C00700000` →
 * 92.73 / 94.30 — both verified live). A NON-degenerate pair is direct
 * evidence of a current-session trade and the snapshot wins regardless of
 * any bar match: "snapshot price equals some older bar's close" proves
 * nothing on a thin contract that revisits price levels for weeks, and
 * inferring staleness from it replaced genuine fresh trades with older bar
 * prices (the original defect of this module's first draft).
 *
 * THE MODEL MARK (2026-08-15) is a THIRD and PREFERRED source, ahead of
 * everything below: when `option-mark.ts` could produce a Black-Scholes mark
 * from the vendor's own IV and delta, that estimate prices the contract and
 * the day pair derives mark-vs-PREVIOUS-mark (dated) or is suppressed.
 * Everything documented below is unchanged and remains the fallback, applied
 * byte-for-byte whenever no mark exists.
 *
 * Authority split, exhaustively:
 * - Non-degenerate pair → SNAPSHOT AUTHORITY: its price and its own day pair
 *   render; the trade is in-session by the vendor's own evidence, so no
 *   no-trade flag and no stale note even while the delayed aggregates lag.
 * - Degenerate pair → BAR AUTHORITY: the vendor itself says "no trade in the
 *   session I describe", so the bars decide everything — the newest bar
 *   out-votes a differing snapshot price, the day pair derives from the two
 *   newest bars (which also fixes the pre-open rolled 0.00%: the derived
 *   pair is yesterday's REAL move, never the rolled zero), and a newest bar
 *   older than the described session becomes an honest "no trades this
 *   session". A GENUINE flat day survives: bars verify the trade date and
 *   the derived pair is a true 0.00%.
 *
 * All price comparison is Decimal equality (`dec().equals()`, never `===` —
 * '13.07' and '13.0700' are one number); every session/date is NY calendar
 * math, never the device timezone.
 */

export interface ResolvedPrint {
  /** Decimal string per share; null iff no quote (bars alone never conjure a
   *  card price — the persistence discipline sits behind them, not a UI). */
  price: string | null;
  /** Which source the price AND the day pair speak for — one source, always. */
  source: 'model' | 'snapshot' | 'bar';
  /**
   * The previous recorded MARK this print's day pair measures from, dated.
   * Present only when `source === 'model'` and a usable previous mark existed
   * — it is what lets the card say `vs estimate of 14 sie` instead of leaving
   * a moving figure unexplained. Optional so every existing construction of a
   * `ResolvedPrint` (and every existing test fixture) stays valid unchanged.
   */
  dayBasisMarkDateISO?: string | null;
  /**
   * The TIP of the day pair, dated, when the tip is itself a RECORDED mark —
   * i.e. while no session is running and the figure describes the last
   * completed session (base evening → tip evening).
   *
   * `null` (or absent) means "the tip is the LIVE mark shown as the price",
   * which is the running-session case. That distinction is what selects the
   * card's wording: a closed-market figure is NOT measured from the price
   * above it, so the label must name both ends rather than one.
   */
  dayBasisTipDateISO?: string | null;
  /**
   * The PER-SHARE mark the day pair is measured FROM — the summary's
   * denominator. Null whenever there is no pair. See `ModelDayBasis.baseMark`
   * for why the summary cannot reconstruct this from the live price.
   */
  dayBasisBaseMark?: string | null;
  /** NY date of the newest real print; null when no bars arrived (a fresh
   *  non-degenerate snapshot with lagging bars reports the described
   *  session — the trade it prices IS in that session). */
  lastTradeDateISO: string | null;
  /** Raw decimal-string day pair — both halves or neither. */
  day: { amt: string; pct: string } | null;
  /** True when the evidence proves the last trade predates the described
   *  session — bars dating it older, or an empty lookback window. */
  noTradeThisSession: boolean;
  /**
   * The 35-day bar window came back EMPTY for a vendor-confirmed-stale
   * (degenerate) snapshot: the contract last traded MORE than the lookback
   * ago. Its months-old price would otherwise render with no dating at all —
   * the stalest class must be the loudest, not the quietest (review finding,
   * 2026-08-15).
   */
  staleBeyondLookback: boolean;
}

/**
 * THE single notion of "a session is running" for options. Every rule in this
 * module that branches on open-vs-shut keys off THIS predicate — two notions
 * of "open" in one file is a bug waiting to happen.
 *
 * `early_trading` is DELIBERATELY treated like `closed` here, unlike
 * `market-clock`'s general notion of an active session: options do not print
 * before 09:30 ET, so counting the pre-market as "today" made every option
 * card say "No trades this session" from 04:00 ET until the bell — the
 * user's prime morning hours — while the stock tiles beside them showed
 * yesterday's move. The user already decided this exact question for stocks
 * (commit 890249d, "Show yesterday's move before the bell, not a flat
 * zero"); options follow the same rule. The asymmetry with the equity
 * polling/status machinery is intentional and options-only.
 *
 * `unknown` (an unrecognised vendor status, possibly a live half-day) also
 * takes the not-running path: a dated, honest last-session figure beats a
 * self-comparison, and the two-dated basis label says which it is.
 */
function sessionRunning(market: MarketSessionInfo): boolean {
  return market.status === 'open' || market.status === 'late_trading';
}

/**
 * Which session a rendered "day" figure would describe: today only while a
 * session runs (per `sessionRunning`), else the last completed one.
 */
function describedSessionISO(market: MarketSessionInfo, nowMs: number): string {
  if (sessionRunning(market)) return nyDateISOAt(nowMs);
  // Conservative fallback to the NY date on a degenerate calendar scan.
  return lastCompletedSessionDateISO(nowMs, []) ?? nyDateISOAt(nowMs);
}

/** One recorded evening mark: the figure and the session it belongs to. */
export interface PreviousMark {
  /** NY calendar date of the session the mark was recorded for. */
  asOf: string;
  /** Decimal string, per share. */
  mark: string;
}

/**
 * How stale a previous mark may be and still be called a "day" move: a long
 * weekend plus a holiday. Anything older is not a day figure and the pair is
 * suppressed rather than stretched.
 */
export const MAX_MARK_BASIS_AGE_DAYS = 5;

/** The day pair for a model-priced contract, with both ends dated. */
interface ModelDayBasis {
  day: { amt: string; pct: string };
  /** The date of the mark the pair is measured FROM. */
  baseISO: string;
  /** The date of the mark the pair is measured TO, or `null` when the tip is
   *  the live mark (running session). */
  tipISO: string | null;
  /**
   * The PER-SHARE mark the pair is measured FROM. Carried out because the
   * summary's "Today" percent needs the pair's own base value as its
   * denominator: while shut, the tip is a recorded evening but the card's
   * price is the LIVE mark, which keeps decaying with theta, so
   * `liveValue − move` is no longer the base it used to be (bug audit,
   * 2026-08-15). Reconstructing the denominator from the live price made the
   * percent drift — and, once the move exceeded the live value, flipped its
   * sign against the amount beside it.
   */
  baseMark: string;
}

/**
 * The model branch's basis selection — the whole point of the closed-market
 * fix, in one pure place.
 *
 * WHILE A SESSION RUNS the live mark is genuinely today's number, so the pair
 * is live-mark vs the newest RECORDED mark strictly before today. Unchanged
 * behaviour, deliberately: `asOf < todayISO` is what stops the 19:30 ET cron's
 * own row from becoming its own comparison base.
 *
 * WHILE THE MARKET IS SHUT the live mark is computed from the last completed
 * session's OWN snapshot data — so comparing it against that same session's
 * recorded mark yields a fabricated 0,00%. The honest figure is the move that
 * actually happened during the last completed session: the two most recent
 * RECORDED marks (Thursday → Friday, shown all weekend), which is exactly the
 * rule the stock tiles already follow (commit 890249d).
 *
 * Anything unmet returns `null` — an em-dash, never a zero and never a guess.
 */
function modelDayBasis(
  recent: readonly PreviousMark[],
  mark: string,
  todayISO: string,
  running: boolean,
): ModelDayBasis | null {
  if (running) {
    // Newest-first, so `find` picks the newest usable row.
    const base = recent.find(
      (m) =>
        m.asOf < todayISO && calendarDaysBetween(todayISO, m.asOf) <= MAX_MARK_BASIS_AGE_DAYS,
    );
    if (base === undefined) return null;
    // Atomic: `deriveDayPair` declines a zero base, and a dated label with no
    // figure beside it would explain nothing.
    const day = deriveDayPair(base.mark, mark);
    return day === null ? null : { day, baseISO: base.asOf, tipISO: null, baseMark: base.mark };
  }

  // Not running: the two most recent RECORDED marks describe the last
  // completed session. Fewer than two → no pair at all.
  if (recent.length < 2) return null;
  const tip = recent[0];
  const base = recent[1];
  // Defensive: a reversed pair would yield a sign-flipped move that looks
  // entirely plausible. The loader orders `desc(asOf)`; assert it here anyway.
  if (!(base.asOf < tip.asOf)) return null;
  // (a) the pair must still be recent enough to be called "the day"...
  if (calendarDaysBetween(todayISO, tip.asOf) > MAX_MARK_BASIS_AGE_DAYS) return null;
  // ...and (b) the two ends must be close enough together to BE one day — a
  // contract untracked for a fortnight must not present a fortnight's move.
  if (calendarDaysBetween(tip.asOf, base.asOf) > MAX_MARK_BASIS_AGE_DAYS) return null;
  const day = deriveDayPair(base.mark, tip.mark);
  return day === null ? null : { day, baseISO: base.asOf, tipISO: tip.asOf, baseMark: base.mark };
}


export function resolveOptionPrints(
  quotes: ReadonlyMap<string, OptionQuoteOutcome>,
  bars: ReadonlyMap<string, readonly Candle[]>,
  market: MarketSessionInfo,
  nowMs: number,
  marks: ReadonlyMap<string, string> = new Map(),
  /** The ≤2 most recent recorded marks per ticker, NEWEST FIRST. Two, not one,
   *  because the shut-market rule compares the last two recorded evenings. */
  recentMarks: ReadonlyMap<string, readonly PreviousMark[]> = new Map(),
): Map<string, ResolvedPrint> {
  const described = describedSessionISO(market, nowMs);
  const running = sessionRunning(market);
  const todayISO = nyDateISOAt(nowMs);
  const resolved = new Map<string, ResolvedPrint>();

  const tickers = new Set<string>([...quotes.keys(), ...bars.keys()]);
  for (const ticker of tickers) {
    const outcome = quotes.get(ticker);
    const quote = outcome?.ok ? outcome.quote : undefined;

    // Ascending by timestamp, defensively — the vendor sorts asc already.
    // `barsKnown` distinguishes "the sync answered with zero bars" (an empty
    // 35-day window IS information) from "the sync never ran / failed"
    // (nothing can be claimed).
    const barsKnown = bars.has(ticker);
    const tickerBars = [...(bars.get(ticker) ?? [])].sort((a, b) => a.t - b.t);
    const newest = tickerBars.length > 0 ? tickerBars[tickerBars.length - 1] : undefined;
    const previous = tickerBars.length > 1 ? tickerBars[tickerBars.length - 2] : undefined;
    const newestDateISO = newest !== undefined ? nyDateISOAt(newest.t) : null;

    // No quote → the existing dash state; bars still date the last print.
    if (quote === undefined) {
      resolved.set(ticker, {
        price: null,
        source: 'snapshot',
        lastTradeDateISO: newestDateISO,
        day: null,
        noTradeThisSession: newestDateISO !== null && newestDateISO < described,
        staleBeyondLookback: false,
      });
      continue;
    }

    // ---- MODEL AUTHORITY (2026-08-15): a Black-Scholes mark built on the
    // vendor's own IV and delta out-ranks BOTH a fresh snapshot and a newer
    // bar. On the thin contracts held here the last trade is wrong by ~20%
    // and is sometimes the holder's own fill (which pins P/L at 0,00 forever);
    // the mark is what the reference mid agrees with (measured +0.02 on
    // ACME). It is an ESTIMATE and every surface labels it as one.
    //
    // The coherent-source rule holds exactly as in the branches below: the
    // day pair is MARK vs PREVIOUS MARK, never a mark minus a traded close —
    // subtracting two different kinds of number is the incoherence this
    // module exists to prevent. No usable previous mark → no pair at all,
    // blank rather than invented.
    //
    // WHICH marks form the pair depends on whether a session is running —
    // see `modelDayBasis`. While shut, the pair is two RECORDED evenings and
    // is NOT measured from the live price shown above it; `dayBasisTipDateISO`
    // is what tells the card to name both ends.
    const mark = marks.get(ticker);
    if (mark !== undefined) {
      const basis = modelDayBasis(recentMarks.get(ticker) ?? [], mark, todayISO, running);

      resolved.set(ticker, {
        price: mark,
        source: 'model',
        // The last real TRADE is still a true, useful fact — the card shows
        // it beside the estimate. It keeps its bar-derived meaning.
        lastTradeDateISO: newestDateISO,
        day: basis?.day ?? null,
        dayBasisMarkDateISO: basis?.baseISO ?? null,
        dayBasisTipDateISO: basis?.tipISO ?? null,
        dayBasisBaseMark: basis?.baseMark ?? null,
        // "No trades this session" explains a missing TRADE-derived day
        // figure. A model-priced card has its own dated basis label, and the
        // phrase would contradict the moving estimate beside it.
        noTradeThisSession: false,
        staleBeyondLookback: barsKnown && newest === undefined,
      });
      continue;
    }

    const snapClose = dec(quote.price);
    const degenerate = quote.prevClose !== null && dec(quote.prevClose).equals(snapClose);

    if (!degenerate && quote.prevClose !== null) {
      // ---- SNAPSHOT AUTHORITY: a non-degenerate pair is the vendor's own
      // evidence of a current-session trade. Price, pair and dating all come
      // from the snapshot — a coincidental match with an older bar's close
      // proves nothing, and the bars (aggregate delay + the 15-min sync TTL)
      // may simply not show this print yet.
      const lastTradeDateISO =
        newestDateISO !== null && newestDateISO >= described ? newestDateISO : described;
      resolved.set(ticker, {
        price: quote.price,
        source: 'snapshot',
        lastTradeDateISO,
        day:
          quote.dayChangeAmt !== null && quote.dayChangePct !== null
            ? { amt: quote.dayChangeAmt, pct: quote.dayChangePct }
            : null,
        noTradeThisSession: false,
        staleBeyondLookback: false,
      });
      continue;
    }

    if (!degenerate) {
      // prevClose is null: no pair to judge freshness by, no pair to render.
      // The price passes through; bars may still date the last print. Nothing
      // stronger is claimable — honest ignorance.
      //
      // A KNOWN-EMPTY lookback window still discloses, exactly as in the bar
      // branch below: a contract with no previous close is the ultra-thin
      // class most likely to have been silent past the window, and its value
      // must not reach the USD total undisclosed.
      const beyond = barsKnown && newest === undefined;
      resolved.set(ticker, {
        price: quote.price,
        source: 'snapshot',
        lastTradeDateISO: newestDateISO,
        day: null,
        noTradeThisSession: beyond || (newestDateISO !== null && newestDateISO < described),
        staleBeyondLookback: beyond,
      });
      continue;
    }

    // ---- BAR AUTHORITY: the degenerate pair says "no trade in the session
    // this snapshot describes" — the bars decide everything.
    if (newest === undefined) {
      // Vendor-confirmed stale AND an empty (or unknown) lookback window.
      const beyond = barsKnown; // empty 35-day window → last trade > 35 days ago
      resolved.set(ticker, {
        price: quote.price,
        source: 'snapshot',
        lastTradeDateISO: null,
        day: null, // the unverifiable maybe-fake 0.00% never renders
        noTradeThisSession: beyond,
        staleBeyondLookback: beyond,
      });
      continue;
    }

    // The newest bar is the freshest real print; a differing close out-votes
    // the rolled snapshot price (the ACME case → 12.10).
    const barWins = !snapClose.equals(dec(newest.close));
    const price = barWins ? newest.close : quote.price;
    const source: ResolvedPrint['source'] = barWins ? 'bar' : 'snapshot';

    if (newestDateISO !== null && newestDateISO >= described) {
      // The print is in-session. The pair derives from the two newest bars —
      // NEVER the snapshot's rolled 0/0: pre-open (early_trading counts as
      // closed here) this yields yesterday's REAL move, and on a genuine
      // flat day it yields a true 0.00%, bar-verified either way.
      resolved.set(ticker, {
        price,
        source,
        lastTradeDateISO: newestDateISO,
        day: previous !== undefined ? deriveDayPair(previous.close, newest.close) : null,
        noTradeThisSession: false,
        staleBeyondLookback: false,
      });
    } else {
      // Bars prove the contract did not trade in the described session — no
      // day figure exists to state, honestly. The fake flat zero dies here.
      resolved.set(ticker, {
        price,
        source,
        lastTradeDateISO: newestDateISO,
        day: null,
        noTradeThisSession: true,
        staleBeyondLookback: false,
      });
    }
  }

  return resolved;
}
