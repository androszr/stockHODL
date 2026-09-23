import { newsArticleResponseSchema } from '@/lib/api/contracts';
import { jsonOk, notFound, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { isValidNewsArticleId } from '@/lib/news/article-id';
import { loadNewsArticleDetail } from '@/lib/news/feed';
import { parseNewsInsights, parseNewsKeywords } from '@/lib/news/insights';

/**
 * One stored article — DATABASE ONLY, never the vendor (a by-id vendor lookup
 * silently returns the WRONG article). An unknown, malformed or pruned id is
 * the same 404, so this cannot be used to probe which articles exist.
 *
 * The jsonb columns are parsed defensively HERE rather than shipped raw: the
 * generated Swift has a concrete type for insights and keywords, and a vendor
 * row with a surprise shape must degrade to an empty list rather than fail a
 * decode on the phone and blank the whole article.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { id } = await params;
  if (!isValidNewsArticleId(id)) return notFound('Article not found.');

  let article: Awaited<ReturnType<typeof loadNewsArticleDetail>>;
  try {
    article = await loadNewsArticleDetail(userId, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'article load failed';
    console.error(`News article load failed: ${message}`);
    return notFound('Article not found.');
  }
  if (article === null) return notFound('Article not found.');

  return jsonOk(
    newsArticleResponseSchema.parse({
      id: article.id,
      title: article.title,
      author: article.author,
      publisherName: article.publisherName,
      publisherHomepage: article.publisherHomepage,
      publishedAtMs: article.publishedAtMs,
      articleUrl: article.articleUrl,
      hasImage: article.hasImage,
      description: article.description,
      tickers: article.tickers,
      linkableTickers: article.linkableTickers,
      keywords: parseNewsKeywords(article.keywords),
      insights: parseNewsInsights(article.insights),
    }),
  );
}
