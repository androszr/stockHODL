import { badRequest, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { isValidNewsArticleId } from '@/lib/news/article-id';
import { publisherLogoResponse } from '@/lib/news/assets';

/**
 * Publisher marks for the native client — the bearer twin of
 * `/api/news/publisher-logo/[id]`; see `src/lib/news/assets.ts` for the fetch
 * policy and the beside-it image route for why a twin exists at all.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { id } = await params;
  if (!isValidNewsArticleId(id)) return badRequest('Invalid article id.');

  return publisherLogoResponse(id);
}
