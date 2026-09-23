import { dec, ZERO } from '@/lib/money';
import { CURRENCIES } from '@/lib/validation';

/**
 * Pure dividend aggregation — isomorphic, no IO, no server marker (the
 * position-engine rationale): the Holdings block and the /dividends page
 * both compute through HERE over the same store rows, which is what makes
 * the per-portfolio figures sum to the combined view BY CONSTRUCTION — one
 * fold, two scopes, never a second ad-hoc sum on either surface.
 *
 * Net is DERIVED, `gross − withheld`, from the stored columns — never stored
 * and never re-derived from a rate at render time. Rows with no frozen PLN
 * rate are COUNTED, not summed — an honest disclosure beats a silently
 * smaller total — and the count is split honestly in two: `awaitingFx` (the
 * currency is on the NBP allowlist, so the next sync can still find the
 * rate) versus `fxUnsupported` (the currency is OUTSIDE the allowlist —
 * every sync will null out forever, and "awaiting" would be a lie; only a
 * hand-entered rate can ever fill it).
 *
 * All arithmetic on Decimal; outputs are decimal STRINGS (formatting is the
 * caller's job — a pl-PL display string must never round-trip back into
 * math).
 */

/** The row shape the fold needs — `DividendPaymentRow` satisfies it. */
export interface DividendSummaryRow {
  portfolioId: string;
  /** 'YYYY-MM-DD'. */
  exDate: string;
  payDate: string | null;
  grossAmount: string;
  withheldTax: string;
  /** Needed to tell "rate still coming" from "no PLN rate exists". */
  currency: string;
  /** Frozen D-1 rate to PLN; null while NBP has not published it. */
  fxRateToBase: string | null;
}

export interface DividendScopeSummary {
  /** Total net received, PLN, decimal string; null when nothing is summable. */
  netPLN: string | null;
  /** Net received this calendar year (by payment date), PLN; null likewise. */
  ytdNetPLN: string | null;
  /** Payment rows in scope — a count, not money. */
  count: number;
  /** Rows excluded from the PLN sums whose rate the next sync can still find. */
  awaitingFx: number;
  /** Rows excluded because their currency has no NBP PLN route at all —
   *  permanent until the user enters a rate by hand, never "awaiting". */
  fxUnsupported: number;
}

/**
 * Whether the app can EVER fetch a PLN rate for this currency: PLN itself
 * short-circuits to 1 and the NBP path serves exactly the `CURRENCIES`
 * allowlist. Outside it the sync nulls the rate on every run forever — that
 * state is "no PLN rate", not "awaiting", and the two are disclosed
 * separately everywhere. The ONE predicate for that decision (the sync and
 * both surfaces all import it from here).
 */
export function isFxSupported(currency: string): boolean {
  return (CURRENCIES as readonly string[]).includes(currency);
}

/** The date a payment is filed under: the day the money arrived, else the
 *  only date the row honestly carries. */
export function paymentDate(row: { exDate: string; payDate: string | null }): string {
  return row.payDate ?? row.exDate;
}

function foldScope(rows: readonly DividendSummaryRow[], yearStartISO: string): DividendScopeSummary {
  let net = ZERO;
  let ytd = ZERO;
  let summed = 0;
  let ytdSummed = 0;
  let awaitingFx = 0;
  let fxUnsupported = 0;

  for (const row of rows) {
    if (row.fxRateToBase === null) {
      if (isFxSupported(row.currency)) awaitingFx += 1;
      else fxUnsupported += 1;
      continue;
    }
    const netPLN = dec(row.grossAmount)
      .minus(dec(row.withheldTax))
      .times(dec(row.fxRateToBase));
    net = net.plus(netPLN);
    summed += 1;
    // ISO dates compare lexically — the YTD boundary is inclusive of Jan 1.
    if (paymentDate(row) >= yearStartISO) {
      ytd = ytd.plus(netPLN);
      ytdSummed += 1;
    }
  }

  return {
    netPLN: summed > 0 ? net.toString() : null,
    ytdNetPLN: ytdSummed > 0 ? ytd.toString() : null,
    count: rows.length,
    awaitingFx,
    fxUnsupported,
  };
}

export interface DividendSummaries {
  all: DividendScopeSummary;
  /** Keyed by portfolioId — serializable (a Record, not a Map). */
  byPortfolioId: Record<string, DividendScopeSummary>;
}

/**
 * All-scope and per-portfolio summaries from ONE fold shape over the same
 * rows. `todayISO` pins the YTD boundary (and keeps the function pure for
 * tests): the year is the payment-date year of "today".
 */
export function summarizeDividends(
  rows: readonly DividendSummaryRow[],
  todayISO: string,
): DividendSummaries {
  const yearStartISO = `${todayISO.slice(0, 4)}-01-01`;

  const byPortfolio = new Map<string, DividendSummaryRow[]>();
  for (const row of rows) {
    const group = byPortfolio.get(row.portfolioId);
    if (group) group.push(row);
    else byPortfolio.set(row.portfolioId, [row]);
  }

  const byPortfolioId: Record<string, DividendScopeSummary> = {};
  for (const [portfolioId, group] of byPortfolio) {
    byPortfolioId[portfolioId] = foldScope(group, yearStartISO);
  }

  return { all: foldScope(rows, yearStartISO), byPortfolioId };
}

/** Per-currency totals for one year group — instrument-currency money. */
export interface YearCurrencyTotal {
  currency: string;
  gross: string;
  withheld: string;
  /** Derived `gross − withheld` — never stored. */
  net: string;
}

export interface YearGroup<T extends DividendSummaryRow> {
  /** 'YYYY'. */
  year: string;
  /** Payment-date descending within the year. */
  rows: T[];
  totals: YearCurrencyTotal[];
  /** Net PLN across the year's rated rows; null when none are summable. */
  netPLN: string | null;
  awaitingFx: number;
  /** Rows whose currency has no NBP PLN route — see `isFxSupported`. */
  fxUnsupported: number;
}

/**
 * Rows grouped by payment-date year, newest year first, rows newest first
 * within each year, with per-year totals per currency plus the PLN net —
 * the /dividends page's whole shape.
 */
export function groupPaymentsByYear<T extends DividendSummaryRow>(
  rows: readonly T[],
): YearGroup<T>[] {
  const byYear = new Map<string, T[]>();
  for (const row of rows) {
    const year = paymentDate(row).slice(0, 4);
    const group = byYear.get(year);
    if (group) group.push(row);
    else byYear.set(year, [row]);
  }

  const years = [...byYear.keys()].sort().reverse();

  return years.map((year) => {
    const groupRows = [...byYear.get(year)!].sort((a, b) => {
      const da = paymentDate(a);
      const db = paymentDate(b);
      return da < db ? 1 : da > db ? -1 : 0;
    });

    const totalsByCurrency = new Map<string, { gross: ReturnType<typeof dec>; withheld: ReturnType<typeof dec> }>();
    let netPLN = ZERO;
    let summed = 0;
    let awaitingFx = 0;
    let fxUnsupported = 0;

    for (const row of groupRows) {
      const bucket = totalsByCurrency.get(row.currency) ?? { gross: ZERO, withheld: ZERO };
      bucket.gross = bucket.gross.plus(dec(row.grossAmount));
      bucket.withheld = bucket.withheld.plus(dec(row.withheldTax));
      totalsByCurrency.set(row.currency, bucket);

      if (row.fxRateToBase === null) {
        if (isFxSupported(row.currency)) awaitingFx += 1;
        else fxUnsupported += 1;
      } else {
        netPLN = netPLN.plus(
          dec(row.grossAmount).minus(dec(row.withheldTax)).times(dec(row.fxRateToBase)),
        );
        summed += 1;
      }
    }

    const totals: YearCurrencyTotal[] = [...totalsByCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, sums]) => ({
        currency,
        gross: sums.gross.toString(),
        withheld: sums.withheld.toString(),
        net: sums.gross.minus(sums.withheld).toString(),
      }));

    return {
      year,
      rows: groupRows,
      totals,
      netPLN: summed > 0 ? netPLN.toString() : null,
      awaitingFx,
      fxUnsupported,
    };
  });
}
