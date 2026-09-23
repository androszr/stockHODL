/**
 * The one news-article id gate — pure, shared by the detail page and the
 * image-proxy route so the two can never drift. Vendor ids observed live
 * 2026-08-16 are 64-char lowercase hex; the pattern allows the URL-safe
 * alphabet with headroom on length, and rejects path metacharacters, empty
 * strings and anything unreasonably long outright.
 */
export const NEWS_ARTICLE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidNewsArticleId(id: string): boolean {
  return NEWS_ARTICLE_ID_RE.test(id);
}
