import 'server-only';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, portfolios } from '@/lib/db';

/**
 * The Holdings screen's portfolio scope (`/?p=<portfolioId>`).
 *
 * One rule, applied everywhere the scope is read: an id that is not a uuid,
 * not this user's, or no longer exists resolves to `null` — the All view.
 * Never a 404, never an error, and never another user's rows: the lookup is
 * scoped by `userId` in SQL, so ownership is not something the caller can
 * forget to check. A deleted portfolio's stale URL simply degrades to All,
 * which is exactly what should happen the moment you delete the scope you
 * were looking at.
 *
 * `?p=a&p=b` is malformed input, not a request for two scopes — the array
 * form resolves to All, mirroring how `?open=` was read before it.
 */
const idSchema = z.uuid();

export async function resolvePortfolioScope(
  userId: string,
  raw: string | string[] | undefined,
): Promise<string | null> {
  if (typeof raw !== 'string') return null;

  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return null;

  const [owned] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, parsed.data), eq(portfolios.userId, userId)))
    .limit(1);

  return owned?.id ?? null;
}
