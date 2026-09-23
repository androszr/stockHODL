import { isValidCalendarDate, normalizeDecimalSeparator } from '@/lib/validation';

/**
 * The BELT over a vision model's own normalization, shared by every
 * screenshot import. The prompt already asks for ISO dates and dot decimals,
 * but a model output is a guess, never a fact — so month names (Polish
 * `sty…gru` is the tested locale), `DD.MM.YYYY` dates and comma decimals are
 * re-normalized here, and anything that still does not fit becomes `null` (an
 * empty field for the user to fill), never a fake zero.
 *
 * Isomorphic, no network, no `server-only`: the same helpers run in the parse
 * action and in the pure prefill layer the client imports. The only money
 * handling here is STRING normalization feeding `decimalString` validation
 * later — no arithmetic, no float parsing.
 */

/** The Server Actions' underlying-symbol shape — uppercase provider notation. */
const TICKER_CANDIDATE_RE = /^[A-Z0-9.]{1,10}$/;

/**
 * Month-name → month-number map, lowercase. Polish abbreviations (the tested
 * locale: `sie` = August, `gru` = December) beside English; full names
 * resolve through their three-letter prefix below.
 */
const MONTHS: Record<string, number> = {
  // Polish
  sty: 1, lut: 2, mar: 3, kwi: 4, maj: 5, cze: 6,
  lip: 7, sie: 8, wrz: 9, 'paź': 10, lis: 11, gru: 12,
  // 'paz' without the diacritic, as OCR sometimes strips it
  paz: 10,
  // English (mar/maj collide nowhere: 'may' is its own key)
  jan: 1, feb: 2, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MONTHNAME_YEAR_RE = /^(\d{1,2})[-. ]([\p{L}]+)[-. ](\d{4})$/u;
/**
 * All-numeric `DD.MM.YYYY` / `DD-MM-YYYY` — DAY FIRST, never month first.
 * Both brokers in scope are Polish (mBank prints `data wykonania 02.09.2026`),
 * and there is no way to tell `12.08` from `08.12` by inspection, so the
 * locale is chosen once, here, rather than guessed per value. A US-format
 * screen would be read wrong by this rule; that is a deliberate, documented
 * choice, and the user re-reads the date on the form before saving.
 */
const DAY_MONTH_YEAR_NUMERIC_RE = /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/;

/**
 * A clock time printed beside the date — Saxo's `Opened` reads
 * `24-sie-2026 18:41:07`, and `Last Updated` the same. The prompt asks for the
 * date alone, but a model output is a guess, and a verbatim copy of that cell
 * used to fall through every branch below and leave the Trade date field
 * empty. Dropped here, before any date shape is tried, so the whole rest of
 * this function keeps working on dates only. The time itself carries nothing
 * this app stores: transactions are dated to the calendar day.
 */
const TRAILING_TIME_RE = /[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?$/;

/**
 * `15-sty-2027` → `2027-01-15`; `15-Jan-2027` → `2027-01-15`; `02.09.2026` →
 * `2026-09-02`; `24-sie-2026 18:41:07` → `2026-08-24`; a plain ISO date passes
 * through. Pure string/count math — never a `Date` round trip that could shift
 * the day west of UTC. Unrecognizable → null (an empty field), never a guess.
 */
export function normalizeDateToISO(value: string): string | null {
  const trimmed = value.trim().replace(TRAILING_TIME_RE, '').trim();
  if (ISO_DATE_RE.test(trimmed)) {
    return isValidCalendarDate(trimmed) ? trimmed : null;
  }

  const numeric = DAY_MONTH_YEAR_NUMERIC_RE.exec(trimmed);
  if (numeric !== null) {
    const [, day, month, year] = numeric;
    return isoOrNull(year, parseInt(month, 10), day);
  }

  const match = DAY_MONTHNAME_YEAR_RE.exec(trimmed);
  if (match === null) return null;
  const [, dayRaw, monthRaw, year] = match;
  const monthToken = monthRaw.toLowerCase();
  const month = MONTHS[monthToken] ?? MONTHS[monthToken.slice(0, 3)];
  if (month === undefined) return null;
  return isoOrNull(year, month, dayRaw);
}

/** Assembles and calendar-checks — `month` is a calendar integer, not money. */
function isoOrNull(year: string, month: number, day: string): string | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isValidCalendarDate(iso) ? iso : null;
}

/**
 * Money-string belt: strip grouping whitespace (JS `\s` covers NBSP and
 * narrow spaces), then resolve the separator through the APP-WIDE rule —
 * `18,35` → `18.35`, `26 354,58` → `26354.58`.
 *
 * It keeps `normalizeDecimalSeparator`'s ambiguity refusal: `5,800` is left
 * exactly as it was printed and fails `decimalString` downstream (loudly),
 * because a comma followed by three digits can equally be thousands grouping.
 * A screen that groups with spaces makes that shape unambiguous, but only for
 * a caller that has actually established it — see `normalizeScreenMoney` in
 * `./transaction-prefill`, which is the ONLY place that widening applies and
 * which owns the evidence for it. This function is the conservative default,
 * used by the options import, where nothing must silently change value.
 */
export function normalizeMoneyString(value: string): string | null {
  const stripped = value.trim().replace(/\s/g, '');
  if (stripped.length === 0) return null;
  const normalized = normalizeDecimalSeparator(stripped);
  return typeof normalized === 'string' ? normalized : null;
}

/** Uppercased and validated, or null — a lowercase or garbage candidate is
 *  rejected, never "fixed" into something the market lookup then trusts. */
export function normalizeTickerCandidate(value: string): string | null {
  const upper = value.trim().toUpperCase();
  return TICKER_CANDIDATE_RE.test(upper) ? upper : null;
}

/**
 * A broker symbol like `SNOW/15F27C240:xcbf` (Saxo option) or `GOOGL:xnas`
 * (Saxo equity) carries the ticker as its leading segment — extracted as a
 * SECONDARY candidate, validated exactly like the primary. Callers decide
 * whether the raw text is symbol-shaped enough to try this at all: a bare
 * phrase like `NASDAQ USD - US30303M1027` would yield `NASDAQ`, which is an
 * exchange, not a ticker.
 */
export function tickerFromBrokerSymbol(text: string): string | null {
  const leading = text.trim().split(/[/:@\s]/, 1)[0] ?? '';
  if (leading.length === 0) return null;
  return normalizeTickerCandidate(leading);
}

/** ISO-4217-shaped or null. */
export function normalizeCurrency(value: string): string | null {
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

export function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
