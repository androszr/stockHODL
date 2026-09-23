import { badRequest, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { isLogoSymbol, logoResponse } from '@/lib/market-data/logo';

/**
 * Brand icons for the native client — the bearer-authenticated twin of
 * `/api/logo/[symbol]`, sharing its whole body through
 * `src/lib/market-data/logo.ts`.
 *
 * The twin exists for the reason every twin in `api/mobile` exists:
 * `src/proxy.ts` is a COOKIE gate whose only exclusion is `/api/mobile/`, so
 * the phone asking the browser route would be redirected to `/login` and
 * decode an HTML page as image bytes.
 *
 * The one non-JSON route under `api/mobile` — the same sanctioned exception
 * the browser half carries, and for the same reason: the vendor's icon URL
 * requires the API key, so the device can never fetch it directly.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { symbol } = await params;
  if (!isLogoSymbol(symbol)) return badRequest('Invalid symbol.');

  return logoResponse(symbol);
}
