import 'server-only';

import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';

import { mapWithConcurrency } from '@/lib/async-pool';
import { db, instruments } from '@/lib/db';
import { massiveProvider } from '@/lib/market-data/massive';
import type { TickerProfile, TickerProfileOutcome } from '@/lib/market-data/provider';

/**
 * The vendor backfill of `instruments.sector` / `sic_code` / description /
 * employees / homepage / shares outstanding — the ONLY writer of those
 * columns, and the ONLY write the whole analytics feature performs.
 *
 * Sync on visit, the `src/lib/dividends/view.ts` precedent: there is no cron
 * for this, so the analytics page fills the gap as it renders. Three things
 * keep that from becoming N vendor calls per page load:
 *
 * 1. **The staleness gate.** Only rows never asked about, or asked about over
 *    `STALE_AFTER_DAYS` ago, are candidates. A company's industry does not
 *    move on a weekly cadence.
 * 2. **The bound.** At most `MAX_PROFILE_SYNC` per call — the
 *    `MAX_BACKFILL_SYMBOLS` precedent — pooled at `PROFILE_CONCURRENCY`, so
 *    a first visit with forty holdings catches up over a few loads instead of
 *    fanning out forty upstream calls at once.
 * 3. **`profile_synced_at` is stamped EVEN WHEN THE VENDOR ANSWERS
 *    "nothing".** Without that, a ticker the vendor will never classify is
 *    re-asked on every single page load forever. The timestamp is what makes
 *    a null `sector` mean "asked, and there is none" rather than "never
 *    asked".
 *
 * **And the rule that makes rule 3 safe (bug audit 2026-08-18, major 4): only
 * a DEFINITIVE outcome is ever written or stamped.** The provider used to
 * answer `null` for every failure mode, so a timeout wrote a null over a
 * known sector AND stamped the row fresh — one blip moved a holding into
 * "Unknown" and locked it there for `STALE_AFTER_DAYS`, which is the exact
 * opposite of what this docstring promises. Now:
 *
 * - `{ ok: true }` — the vendor answered; its answer is written and stamped,
 *   nulls included, because a vendor that knows the ticker and lists no
 *   industry IS the truth about that ticker.
 * - `not_found` — definitive; nothing is written, but the row is STAMPED so
 *   the sync stops asking about a ticker the vendor does not carry.
 * - `error` — transient; the row and its timestamp are both left untouched,
 *   so the next visit retries and nothing known is lost.
 *
 * Never throws. A failure logs its message only — never the key, never a URL,
 * never a user id — and leaves the row exactly as it was, so the screen shows
 * "Unknown" rather than an error.
 */

export const MAX_PROFILE_SYNC = 12;
const PROFILE_CONCURRENCY = 5;
const STALE_AFTER_DAYS = 30;

/** One instrument the sync may refresh. */
export interface ProfileCandidate {
  id: string;
  symbol: string;
}

/**
 * The injectable seam — the same arrangement `price-history.ts` uses, so the
 * staleness gate, the bound and the stamp-on-null rule are testable without
 * mocking Drizzle chains.
 */
export interface ProfileIO {
  listStale(instrumentIds: readonly string[], staleBefore: Date): Promise<ProfileCandidate[]>;
  fetchProfile(symbol: string): Promise<TickerProfileOutcome>;
  /**
   * `profile === null` means STAMP ONLY — the vendor is definitively silent
   * about this ticker, so the timestamp moves and the classification columns
   * are left exactly as they were. It never means "write nulls".
   */
  save(instrumentId: string, profile: TickerProfile | null, syncedAt: Date): Promise<void>;
}

const realIO: ProfileIO = {
  async listStale(instrumentIds, staleBefore) {
    return db
      .select({ id: instruments.id, symbol: instruments.symbol })
      .from(instruments)
      .where(
        and(
          inArray(instruments.id, [...instrumentIds]),
          or(
            isNull(instruments.profileSyncedAt),
            lt(instruments.profileSyncedAt, staleBefore),
          ),
        ),
      )
      .limit(MAX_PROFILE_SYNC);
  },

  fetchProfile(symbol) {
    return massiveProvider.getTickerProfile(symbol);
  },

  async save(instrumentId, profile, syncedAt) {
    await db
      .update(instruments)
      .set(
        profile === null
          ? // Stamp only: the vendor does not carry this ticker, which is a
            // reason to stop asking and NOT a reason to erase what is known.
            { profileSyncedAt: syncedAt }
          : {
              sector: profile.sector,
              // `instruments.country` is deliberately NOT written: the provider
              // has no domicile field, and `locale` is the listing market. See
              // schema.ts.
              sicCode: profile.sicCode,
              description: profile.description,
              totalEmployees: profile.totalEmployees,
              homepageUrl: profile.homepageUrl,
              sharesOutstanding: profile.sharesOutstanding,
              profileSyncedAt: syncedAt,
            },
      )
      .where(eq(instruments.id, instrumentId));
  },
};

/** Testable core — see `ProfileIO`. */
export async function syncInstrumentProfilesWith(
  io: ProfileIO,
  instrumentIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  if (instrumentIds.length === 0) return;

  const staleBefore = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  let candidates: ProfileCandidate[];
  try {
    candidates = await io.listStale(instrumentIds, staleBefore);
  } catch (error) {
    console.error(`Instrument profile sync failed: ${message(error)}`);
    return;
  }

  // The SQL `limit` already bounds this; the slice is the second lock, so a
  // future query change cannot quietly widen the vendor fan-out.
  const bounded = candidates.slice(0, MAX_PROFILE_SYNC);
  if (bounded.length === 0) return;

  await mapWithConcurrency(bounded, PROFILE_CONCURRENCY, async (candidate) => {
    try {
      // Never-throw by contract, but a provider is a provider: the try is the
      // guarantee, not the documentation.
      const outcome = await io.fetchProfile(candidate.symbol);
      if (!outcome.ok && outcome.reason === 'error') {
        // Transient. Write nothing, stamp nothing, retry next visit — the one
        // rule that keeps a vendor hiccup from erasing a month of truth.
        return;
      }
      // Definitive: the vendor's answer, or a stamp-only for a ticker it does
      // not carry. Stamped either way — see rule 3 above.
      await io.save(candidate.id, outcome.ok ? outcome.profile : null, now);
    } catch (error) {
      console.error(`Instrument profile sync failed: ${message(error)}`);
    }
  });
}

export function syncInstrumentProfiles(instrumentIds: readonly string[]): Promise<void> {
  return syncInstrumentProfilesWith(realIO, instrumentIds);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'profile sync failed';
}
