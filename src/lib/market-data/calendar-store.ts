import 'server-only';

import { sql } from 'drizzle-orm';

import { db, marketCalendar, marketCalendarCoverage } from '@/lib/db';

import type { CalendarOverride } from './market-clock';

/**
 * The `server-only` owner of the two market-calendar tables. The vendor's
 * upcoming-calendar feed is FUTURE-only, so this store is the app's memory of
 * closures whose dates have passed: every successful vendor fetch is written
 * through here (rows retained forever — published calendars are effectively
 * immutable), and reads return everything the store has ever captured plus
 * the coverage horizon that says since WHEN it has been listening.
 *
 * Failure discipline (non-negotiable for the quote path): nothing in this
 * module ever throws to a caller. A read failure degrades to "no stored rows,
 * no horizon" — vendor-only overrides and honestly timeless labels; a write
 * failure is logged and skipped. Quotes, market status and charts must keep
 * working with the tables unreachable, exactly as they did before the tables
 * existed. Logs carry a message only — never a URL, key or connection string.
 *
 * `known_from` is SET-ONCE (insert-if-absent): moving it backward would
 * retroactively vouch for dates the store never observed, which is precisely
 * the lie the horizon exists to prevent.
 */

/** The one coverage row — US equities is the only market this app knows. */
const MARKET_KEY = 'us-equities';

export interface StoredCalendar {
  /**
   * Did the read actually reach the store? A failure returns the SAME shape as
   * an empty store, so callers that must not cache a degraded picture need
   * this to tell "nothing stored yet" from "could not look".
   */
  ok: boolean;
  overrides: CalendarOverride[];
  /**
   * 'YYYY-MM-DD' NY date since which the store can vouch for the calendar,
   * or null when no coverage row exists yet (fresh table — the honest answer
   * for every past date is then "unknown", rendered as a timeless label).
   */
  knownFromISO: string | null;
}

/** All stored rows + the coverage horizon; any failure → empty and null. */
export async function readStoredCalendar(): Promise<StoredCalendar> {
  try {
    const [rows, coverage] = await Promise.all([
      db.select().from(marketCalendar),
      db.select().from(marketCalendarCoverage),
    ]);

    const overrides: CalendarOverride[] = [];
    for (const row of rows) {
      // The status column is free text at the DB level; anything but the two
      // CalendarOverride words is dropped, never guessed at.
      if (row.status !== 'closed' && row.status !== 'early-close') continue;
      overrides.push({
        date: row.date,
        status: row.status,
        // Timestamps, never money — epoch ms out of timestamptz Dates.
        ...(row.openAt !== null ? { openMs: row.openAt.getTime() } : {}),
        ...(row.closeAt !== null ? { closeMs: row.closeAt.getTime() } : {}),
      });
    }

    const knownFromISO = coverage.find((c) => c.market === MARKET_KEY)?.knownFrom ?? null;
    return { ok: true, overrides, knownFromISO };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'calendar read failed';
    console.error(`Market calendar store read failed: ${message}`);
    return { ok: false, overrides: [], knownFromISO: null };
  }
}

/**
 * Write-through after a successful vendor fetch: upsert every advertised row
 * (fresh data wins — a published correction must propagate) and set the
 * coverage horizon ONCE to `todayISO` (the NY date of the first successful
 * capture; `onConflictDoNothing` is the set-once guarantee). Returns whether
 * the coverage row is trustworthy after this call — false on any failure, so
 * the caller never claims a horizon the store did not actually record.
 */
export async function persistFetchedCalendar(
  fetched: readonly CalendarOverride[],
  todayISO: string,
): Promise<boolean> {
  try {
    if (fetched.length > 0) {
      await db
        .insert(marketCalendar)
        .values(
          fetched.map((o) => ({
            date: o.date,
            status: o.status,
            openAt: o.openMs !== undefined ? new Date(o.openMs) : null,
            closeAt: o.closeMs !== undefined ? new Date(o.closeMs) : null,
            fetchedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: marketCalendar.date,
          set: {
            status: sql`excluded.status`,
            openAt: sql`excluded.open_at`,
            closeAt: sql`excluded.close_at`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }

    await db
      .insert(marketCalendarCoverage)
      .values({ market: MARKET_KEY, knownFrom: todayISO })
      .onConflictDoNothing({ target: marketCalendarCoverage.market });

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'calendar write failed';
    console.error(`Market calendar store write failed: ${message}`);
    return false;
  }
}
