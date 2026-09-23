import 'server-only';

import { lt } from 'drizzle-orm';

import { db, newsArticles, newsArticleTickers } from '@/lib/db';
import type { NewsArticle } from '@/lib/market-data/massive-mapping';

/**
 * The `server-only` owner of the two news tables — the ONLY writer (the
 * `calendar-store.ts` rule). Persistence is what makes the detail page
 * correct at all: the vendor has no working fetch-by-id (`?id=` silently
 * returns the newest article — verified live 2026-08-16), so a tapped card
 * can only ever be re-served from these rows.
 *
 * Failure discipline, calendar-store adjacent: nothing here throws to a
 * caller. A write failure is logged (message only — never a key or URL) and
 * reported as `false` — NOT swallowed as cosmetic: the rows are the identity
 * source the feed reads from, so fetched stories that never reached them are
 * as absent as a failed fetch and the caller must degrade honestly
 * (2026-08-16, fix-news-ticker-filter plan).
 */

/** Stories older than this are pruned on the write path — no cron. */
export const NEWS_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Insert fetched articles + their ticker join rows. `onConflictDoNothing` on
 * both: article ids are the vendor's own and re-arrive on every refresh —
 * first write wins, a story is immutable once shown (re-writing would let a
 * vendor edit make a tapped card open different content than the card
 * showed). NOTE: `onConflictDoNothing` forgives conflicts with EXISTING rows
 * only — duplicate ids inside ONE statement still reject the whole insert,
 * so the caller dedupes by id before calling.
 *
 * Returns `true` iff both inserts committed (empty input is trivially
 * `true`), `false` on the caught failure — still logged message-only, still
 * never thrown.
 */
export async function persistArticles(articles: readonly NewsArticle[]): Promise<boolean> {
  if (articles.length === 0) return true;

  try {
    await db
      .insert(newsArticles)
      .values(
        articles.map((a) => ({
          id: a.id,
          title: a.title,
          author: a.author,
          publisherName: a.publisherName,
          publisherHomepage: a.publisherHomepage,
          // Stored verbatim; the publisher-logo proxy enforces origin/scheme/
          // content-type at fetch time. Pre-existing rows keep null — honest
          // absence, retired naturally by the 90-day prune.
          publisherLogoUrl: a.publisherLogoUrl,
          publisherFaviconUrl: a.publisherFaviconUrl,
          // A timestamp, not money — epoch ms into timestamptz.
          publishedAt: new Date(a.publishedAtMs),
          articleUrl: a.articleUrl,
          imageUrl: a.imageUrl,
          description: a.description,
          keywords: a.keywords,
          insights: a.insights,
        })),
      )
      .onConflictDoNothing({ target: newsArticles.id });

    const joinRows = articles.flatMap((a) =>
      a.tickers.map((ticker) => ({ articleId: a.id, ticker })),
    );
    if (joinRows.length > 0) {
      await db.insert(newsArticleTickers).values(joinRows).onConflictDoNothing();
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'news write failed';
    console.error(`News store write failed: ${message}`);
    return false;
  }
}

/**
 * Drop stories published more than {@link NEWS_RETENTION_DAYS} ago. ONE
 * statement — the join rows go with their article via the FK cascade, never
 * a second delete racing the first.
 */
export async function pruneOldArticles(now: Date = new Date()): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - NEWS_RETENTION_DAYS * DAY_MS);
    await db.delete(newsArticles).where(lt(newsArticles.publishedAt, cutoff));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'news prune failed';
    console.error(`News store prune failed: ${message}`);
  }
}
