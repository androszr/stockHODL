import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';

import { invalidateAnalyticsMemo } from '@/lib/analytics/view';
import { db, instruments, portfolios, portfolioTargets } from '@/lib/db';
import { dec, toNumeric } from '@/lib/money';

/**
 * Per-portfolio target weights — reads and writes, owned here so the route
 * handler stays three lines (`portfolios/mutations.ts` discipline). The
 * caller derives the user id from a session; every statement in this module
 * is scoped through `portfolios.userId`, never by a client-supplied id
 * alone, and a foreign portfolio id is the SAME "not found" answer as a
 * missing one — nothing enumerable.
 *
 * The write is a BULK REPLACE: delete-then-insert in one `db.batch`, the
 * `reorderPortfolios` atomicity mechanism (Neon HTTP has no interactive
 * transactions). A delete that landed without its inserts would wipe every
 * target on a flaky save, so the two travel together or not at all. The
 * delete statement also keeps the batch tuple non-empty for a clearing save
 * (empty `rows` is legal — a blank field is an omitted row, never a `0`).
 */

/** The stored `target_pct` column is numeric(7,4). */
const TARGET_PCT_SCALE = 4;

export const PORTFOLIO_NOT_FOUND = 'Portfolio not found.';
export const UNKNOWN_INSTRUMENT = 'Unknown instrument.';

export interface StoredTarget {
  instrumentId: string;
  /**
   * The ticker, joined in. The edit sheet needs it to show a row for a
   * target the disk-cached analytics payload does not list — that payload
   * is the sheet's other row source and it can be minutes old.
   */
  symbol: string;
  /** Decimal string, `dec()`-normalised so numeric padding never leaks. */
  targetPct: string;
}

export type TargetsRead =
  | { ok: true; rows: StoredTarget[] }
  | { ok: false; error: string };

export type TargetsMutation = { ok: true } | { ok: false; error: string };

/**
 * One portfolio's targets, oldest first. The ownership check answers
 * not-found for a foreign or missing portfolio BEFORE any target row is
 * read — an empty list is reserved for a portfolio the user owns that
 * simply has no targets, which is a different statement.
 */
export async function getTargets(userId: string, portfolioId: string): Promise<TargetsRead> {
  if (!(await ownsPortfolio(userId, portfolioId))) {
    return { ok: false, error: PORTFOLIO_NOT_FOUND };
  }

  const rows = await db
    .select({
      instrumentId: portfolioTargets.instrumentId,
      symbol: instruments.symbol,
      targetPct: portfolioTargets.targetPct,
    })
    .from(portfolioTargets)
    .innerJoin(instruments, eq(instruments.id, portfolioTargets.instrumentId))
    .where(eq(portfolioTargets.portfolioId, portfolioId))
    .orderBy(asc(portfolioTargets.createdAt));

  return {
    ok: true,
    // numeric(7,4) pads ('30.0000'); re-normalise so the wire carries '30'.
    rows: rows.map((r) => ({
      instrumentId: r.instrumentId,
      symbol: r.symbol,
      targetPct: dec(r.targetPct).toString(),
    })),
  };
}

/**
 * Replace the whole target list for one portfolio, atomically.
 *
 * Order matters: ownership FIRST (foreign and missing ids share one
 * not-found), then instrument existence (a friendly refusal instead of an
 * FK violation surfacing as a 500 — and no more information than the FK
 * itself would leak), then the batched rewrite, then the memo invalidation
 * that keeps the drift card honest for the save the sheet just confirmed.
 */
export async function replaceTargets(
  userId: string,
  portfolioId: string,
  rows: readonly { instrumentId: string; targetPct: string }[],
): Promise<TargetsMutation> {
  if (!(await ownsPortfolio(userId, portfolioId))) {
    return { ok: false, error: PORTFOLIO_NOT_FOUND };
  }

  if (rows.length > 0) {
    const ids = rows.map((r) => r.instrumentId);
    const known = await db
      .select({ id: instruments.id })
      .from(instruments)
      .where(inArray(instruments.id, ids));
    if (known.length !== new Set(ids).size) {
      return { ok: false, error: UNKNOWN_INSTRUMENT };
    }
  }

  const del = db
    .delete(portfolioTargets)
    .where(eq(portfolioTargets.portfolioId, portfolioId));
  const statements =
    rows.length === 0
      ? [del]
      : [
          del,
          db.insert(portfolioTargets).values(
            rows.map((r) => ({
              portfolioId,
              instrumentId: r.instrumentId,
              targetPct: toNumeric(dec(r.targetPct), TARGET_PCT_SCALE),
            })),
          ),
        ];

  // Neon HTTP has no interactive transactions; batch keeps the rewrite
  // atomic. The tuple is non-empty by construction — the delete is always
  // there, clearing save included.
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);

  // Without this, the Analytics memo keeps serving pre-save drift for up to
  // its 60 s TTL — the one staleness the user would see within a minute of
  // confirming the sheet.
  invalidateAnalyticsMemo(userId);

  return { ok: true };
}

/** The ownership gate: the portfolio row must exist under THIS user. */
async function ownsPortfolio(userId: string, portfolioId: string): Promise<boolean> {
  const owned = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  return owned.length > 0;
}
