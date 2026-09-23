import { badRequest, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { isValidNewsArticleId } from '@/lib/news/article-id';
import { newsImageResponse } from '@/lib/news/assets';

/**
 * Article hero images for the native client — the bearer twin of
 * `/api/news/image/[id]`, sharing its whole body through
 * `src/lib/news/assets.ts` (where every fetch decision is documented).
 *
 * A twin rather than a shared route because `src/proxy.ts` is a COOKIE gate
 * excluding only `/api/mobile/`: the phone asking the browser route would be
 * redirected to `/login` and decode an HTML page as image bytes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { id } = await params;
  if (!isValidNewsArticleId(id)) return badRequest('Invalid article id.');

  return newsImageResponse(id);
}
