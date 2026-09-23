/**
 * Pure NYSE session math — the trading calendar as arithmetic.
 *
 * Deliberately isomorphic: no `server-only`, no fetch, no dependencies beyond
 * the built-in `Intl` API. The vendor's holiday/early-close calendar arrives
 * as `CalendarOverride[]` (mapped in `massive-mapping.ts`); everything else —
 * weekday sessions, extended hours, DST on the market's side — is derived
 * here from `America/New_York` wall-clock rules.
 *
 * DST is the sharp edge this module exists for: sessions are New York
 * wall-clock (09:30–16:00), the server runs UTC, the user sits in
 * Europe/Warsaw, and the US and EU change clocks on DIFFERENT weekends — so
 * "close is 22:00 Warsaw" is false for weeks every year. Nothing here
 * hardcodes an offset. Every ET instant comes from `nyOffsetMinutes()`
 * (Intl-derived) via iterate-and-correct conversion.
 *
 * Every timestamp in this file is epoch milliseconds — a timestamp, never
 * money, never Decimal. `Number()` on a date component is a count, not a
 * price.
 */

/** One calendar exception, keyed by the NY calendar date it applies to. */
export interface CalendarOverride {
  /** NY calendar date, plain 'YYYY-MM-DD'. */
  date: string;
  status: 'closed' | 'early-close';
  /** Explicit UTC epoch ms; present only on early-close days (the vendor
   *  publishes exact instants for those, none for full closures). */
  openMs?: number;
  closeMs?: number;
}

export type MarketPhase = 'open' | 'closed' | 'early_trading' | 'late_trading';

export interface SessionTimes {
  /** Regular-session open, epoch ms UTC. */
  openMs: number;
  /** Regular-session close, epoch ms UTC. */
  closeMs: number;
}

export interface MarketTransition {
  atMs: number;
  kind: 'open' | 'close';
}

/** Early (pre-market) session begins at 04:00 ET. */
const EARLY_OPEN_HOUR = 4;
/** Late (after-hours) session runs 4 h past the regular close. */
const LATE_SESSION_MS = 4 * 60 * 60 * 1000;
/** Regular session, New York wall clock. */
const REGULAR_OPEN = { hour: 9, minute: 30 };
const REGULAR_CLOSE = { hour: 16, minute: 0 };
/** NYSE early-close days end at 13:00 ET — the fallback when the vendor's
 *  `early-close` row carries no explicit UTC instant. Falling back to the
 *  full-session 16:00 would count down over a closed market for three hours. */
const EARLY_CLOSE = { hour: 13, minute: 0 };
/** Forward-scan bound: no NYSE closure streak comes close to two weeks. */
const MAX_SCAN_DAYS = 14;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Cached formatter — Intl.DateTimeFormat construction is expensive. */
const NY_PARTS_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** New York wall-clock reading of a UTC instant. */
function nyWallClockAt(utcMs: number): WallClock {
  const parts = NY_PARTS_FORMAT.formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    // Date components are counts, not money — Number() is sanctioned here.
    return part ? Number(part.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds emit '24' at midnight even with hour12: false.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * Offset of America/New_York from UTC in minutes at a given instant:
 * −240 during EDT, −300 during EST. Derived, never hardcoded.
 */
export function nyOffsetMinutes(utcMs: number): number {
  // Sub-second remainder would skew the division; the offset is whole-minute.
  const wholeSecond = Math.floor(utcMs / 1000) * 1000;
  const w = nyWallClockAt(wholeSecond);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((wallAsUtc - wholeSecond) / MS_PER_MINUTE);
}

/** 'YYYY-MM-DD' → [year, month, day] as plain counts. */
function splitDateISO(dateISO: string): [number, number, number] {
  const [y, m, d] = dateISO.split('-');
  return [Number(y), Number(m), Number(d)];
}

/**
 * A New York wall-clock time on a NY calendar date → epoch ms UTC, by
 * iterate-and-correct: guess with offset 0, then re-derive the offset at the
 * guess until it stabilizes. Session times (04:00–20:00) never fall inside
 * the 1–3 a.m. transition window, so two iterations always converge.
 */
function nyWallToUtc(dateISO: string, hour: number, minute: number): number {
  const [y, m, d] = splitDateISO(dateISO);
  const wallAsUtc = Date.UTC(y, m - 1, d, hour, minute);
  let utc = wallAsUtc;
  for (let i = 0; i < 3; i++) {
    const corrected = wallAsUtc - nyOffsetMinutes(utc) * MS_PER_MINUTE;
    if (corrected === utc) break;
    utc = corrected;
  }
  return utc;
}

/** NY calendar date of a UTC instant, as 'YYYY-MM-DD'. */
export function nyDateISOAt(utcMs: number): string {
  const w = nyWallClockAt(utcMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Weekday of a calendar date (0 = Sunday … 6 = Saturday) — timezone-free. */
function weekdayOf(dateISO: string): number {
  const [y, m, d] = splitDateISO(dateISO);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Calendar-date arithmetic in pure UTC — DST cannot touch it. */
function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = splitDateISO(dateISO);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * The regular session for a NY calendar date: 09:30–16:00 ET on weekdays,
 * null on weekends and full-closure overrides. Early-close overrides use the
 * vendor's explicit UTC instants when present; an early-close row WITHOUT an
 * explicit close still closes early — at the NYSE-standard 13:00 ET — never
 * at the full-session 16:00 (which would report "open" over a closed market).
 */
export function regularSessionFor(
  dateISO: string,
  overrides: readonly CalendarOverride[],
): SessionTimes | null {
  const weekday = weekdayOf(dateISO);
  if (weekday === 0 || weekday === 6) return null;

  const override = overrides.find((o) => o.date === dateISO);
  if (override?.status === 'closed') return null;

  const isEarlyClose = override?.status === 'early-close';
  const openMs =
    isEarlyClose && override.openMs !== undefined
      ? override.openMs
      : nyWallToUtc(dateISO, REGULAR_OPEN.hour, REGULAR_OPEN.minute);
  const closeMs =
    isEarlyClose && override.closeMs !== undefined
      ? override.closeMs
      : isEarlyClose
        ? nyWallToUtc(dateISO, EARLY_CLOSE.hour, EARLY_CLOSE.minute)
        : nyWallToUtc(dateISO, REGULAR_CLOSE.hour, REGULAR_CLOSE.minute);
  return { openMs, closeMs };
}

/**
 * Derived market phase at an instant: early session opens 04:00 ET, the late
 * session ends 4 h after the (possibly early) close. This is the FALLBACK and
 * the transition math — the vendor's live status is authoritative when the
 * two disagree (ad-hoc halts are not in any calendar).
 */
export function statusAt(nowMs: number, overrides: readonly CalendarOverride[]): MarketPhase {
  const dateISO = nyDateISOAt(nowMs);
  const session = regularSessionFor(dateISO, overrides);
  if (!session) return 'closed';

  const earlyStartMs = nyWallToUtc(dateISO, EARLY_OPEN_HOUR, 0);
  const lateEndMs = session.closeMs + LATE_SESSION_MS;

  if (nowMs < earlyStartMs || nowMs >= lateEndMs) return 'closed';
  if (nowMs < session.openMs) return 'early_trading';
  if (nowMs < session.closeMs) return 'open';
  return 'late_trading';
}

/**
 * The NY calendar date of the most recent COMPLETED regular session at
 * `nowMs` — the newest date whose close is already in the past, scanning
 * backward at most {@link MAX_SCAN_DAYS} days (null past the bound,
 * degenerate by construction). This is the honest right edge for anything
 * recording "we have this day's FINAL close": a session still running (or
 * not yet opened) has no final close to record yet.
 */
export function lastCompletedSessionDateISO(
  nowMs: number,
  overrides: readonly CalendarOverride[],
): string | null {
  let dateISO = nyDateISOAt(nowMs);
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const session = regularSessionFor(dateISO, overrides);
    if (session && nowMs >= session.closeMs) return dateISO;
    dateISO = addDaysISO(dateISO, -1);
  }
  return null;
}

/**
 * The last `count` COMPLETED regular sessions at `nowMs`, OLDEST FIRST — the
 * calendar the trend strip places its marks on.
 *
 * Why a caller needs this at all: "the last five rows we stored" and "the last
 * five sessions" are the same list only while the recorder never misses an
 * evening. For an option contract they are routinely different by
 * construction — `option_daily_closes` records nothing on a day the contract
 * did not trade, and `option_daily_marks` records nothing on an evening no
 * mark could be produced — so a grader walking adjacent stored rows compares
 * Monday against Thursday and calls it one day's move. It hands back dates so
 * the caller can leave a session it has no figure for as a HOLE.
 *
 * Overrides are REQUIRED rather than optional, and that is not defensiveness:
 * `regularSessionFor` rejects weekends on its own but knows nothing about
 * holidays, so a caller passing `[]` gets Thanksgiving in its session list.
 * `mark-sync.ts` documents the live bug that argument already caused once.
 *
 * Shorter than `count` when the scan bound is reached — degenerate by
 * construction, like the other scans here, and a short list is the honest
 * answer rather than a padded one.
 */
export function recentSessionDatesISO(
  count: number,
  nowMs: number,
  overrides: readonly CalendarOverride[],
): string[] {
  if (count <= 0) return [];

  const newestFirst: string[] = [];
  let dateISO = lastCompletedSessionDateISO(nowMs, overrides);
  if (dateISO === null) return [];

  // Generous bound: five sessions span a week of calendar days, and a holiday
  // week stretches that. Seven days per session cannot be reached by any real
  // closure and still terminates on a pathological override set.
  const scanBound = count * 7;
  for (let i = 0; i <= scanBound && newestFirst.length < count; i++) {
    if (regularSessionFor(dateISO, overrides)) newestFirst.push(dateISO);
    dateISO = addDaysISO(dateISO, -1);
  }

  return newestFirst.reverse();
}

/** Which extended session a reading belongs to, and its honest end instant. */
export interface ExtendedSessionAttribution {
  kind: 'early' | 'late';
  /**
   * Whether that session is STILL RUNNING at `nowMs`. Liveness is its OWN
   * fact, never inferred from `endedAtMs === null` — the unvouched-horizon
   * case below suppresses the instant on a session that HAS ended, and the
   * two must stay distinguishable (an ended reading renders dimmed).
   * Invariant: `live === true ⇒ endedAtMs === null`; `live: false` with
   * `endedAtMs: null` means "ended, instant unvouched".
   */
  live: boolean;
  /**
   * Epoch ms end of that session — a timestamp, never money. Null when the
   * session has STARTED but not yet ended at `nowMs`: the honest answer is
   * then "no instant", never a future or invented one.
   */
  endedAtMs: number | null;
}

/**
 * Which early/late session is the MOST RECENT one that has started at
 * `nowMs`, and when it ended — the attribution behind the persistent
 * extended-hours line (2026-08-13 reversal of the only-while-running rule,
 * plans/2026-08-13-extended-hours-last-reading.md). The vendor keeps the
 * `early_trading_*` and `late_trading_*` pairs populated side by side with no
 * per-figure timestamp (`session.last_updated` is snapshot-wide and banned as
 * a proxy), so "which figure is newer" is CLOCK arithmetic, not payload
 * inspection — it lives here with the rest of the pure session math.
 *
 * Backward scan, newest first (the {@link lastCompletedSessionDateISO}
 * pattern): for the newest date with a regular session,
 * - past the late end (close + 4 h) → that late session, ended then;
 * - inside the late window → the late session, still live (no instant);
 * - inside the regular session → the early session, which ended at the open;
 * - inside the early window (from 04:00 ET) → the early session, live;
 * - before 04:00 ET → the previous day's answer.
 * Null past the scan bound — degenerate by construction, like the other
 * scans. Every instant derives from the Intl-based session bounds; nothing
 * here hardcodes an offset.
 *
 * The regular-session suppression (no extended line while the vendor says
 * `open` — the day figure already contains the pre-market move) is the
 * CALLER's rule on the vendor's authoritative status: this function is only
 * consulted for `closed`/`unknown` payloads, where the clock is the only
 * honest arbiter (the mid-window branches cover vendor lag and halts).
 *
 * `knownFromISO` is the durable calendar store's KNOWLEDGE HORIZON (see
 * calendar-store.ts): the vendor's upcoming feed is future-only, so for
 * dates before the horizon the overrides cannot be trusted to contain past
 * closures — a scan there might read a holiday as a trading day. When the
 * attributed session's NY date predates the horizon (or the horizon is null,
 * no coverage yet), the KIND is still returned — while closed, the newest
 * persisted vendor figure is the late pair regardless of which day it traded
 * — but `endedAtMs` is suppressed to null: the session name renders with no
 * time, never with a weekday-schedule guess.
 */
export function extendedAttribution(
  nowMs: number,
  overrides: readonly CalendarOverride[],
  knownFromISO: string | null,
): ExtendedSessionAttribution | null {
  let dateISO = nyDateISOAt(nowMs);
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const session = regularSessionFor(dateISO, overrides);
    if (session) {
      // ISO date strings order lexicographically — a count comparison, not money.
      const vouched = knownFromISO !== null && dateISO >= knownFromISO;
      const lateEndMs = session.closeMs + LATE_SESSION_MS;
      if (nowMs >= lateEndMs) {
        return { kind: 'late', live: false, endedAtMs: vouched ? lateEndMs : null };
      }
      if (nowMs >= session.closeMs) return { kind: 'late', live: true, endedAtMs: null };
      if (nowMs >= session.openMs) {
        return { kind: 'early', live: false, endedAtMs: vouched ? session.openMs : null };
      }
      const earlyStartMs = nyWallToUtc(dateISO, EARLY_OPEN_HOUR, 0);
      if (nowMs >= earlyStartMs) return { kind: 'early', live: true, endedAtMs: null };
    }
    dateISO = addDaysISO(dateISO, -1);
  }
  return null;
}

/**
 * The next regular-session boundary: while the regular session runs, its
 * close; in every other phase, the next regular open — scanning forward at
 * most {@link MAX_SCAN_DAYS} days (null past the bound, degenerate by
 * construction).
 */
export function nextTransition(
  nowMs: number,
  overrides: readonly CalendarOverride[],
): MarketTransition | null {
  const todayISO = nyDateISOAt(nowMs);
  const today = regularSessionFor(todayISO, overrides);
  if (today && nowMs >= today.openMs && nowMs < today.closeMs) {
    return { atMs: today.closeMs, kind: 'close' };
  }

  let dateISO = todayISO;
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const session = regularSessionFor(dateISO, overrides);
    if (session && session.openMs > nowMs) return { atMs: session.openMs, kind: 'open' };
    dateISO = addDaysISO(dateISO, 1);
  }
  return null;
}

/**
 * When session activity (early open 04:00 ET through late close) next exists —
 * the instant quote polling becomes worthwhile again. Returns `nowMs` when
 * already inside an activity window, null past the scan bound.
 */
export function nextSessionActivity(
  nowMs: number,
  overrides: readonly CalendarOverride[],
): number | null {
  let dateISO = nyDateISOAt(nowMs);
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const session = regularSessionFor(dateISO, overrides);
    if (session) {
      const startMs = nyWallToUtc(dateISO, EARLY_OPEN_HOUR, 0);
      const endMs = session.closeMs + LATE_SESSION_MS;
      if (nowMs < startMs) return startMs;
      if (nowMs < endMs) return nowMs;
    }
    dateISO = addDaysISO(dateISO, 1);
  }
  return null;
}
