import { screenshotImportRequestSchema } from '@/lib/api/contracts';
import { importFailureResponse } from '@/lib/api/mobile/import-respond';
import { jsonOk, parseJsonBody, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { parseOptionScreenshotImage } from '@/lib/screenshots/parse';

/**
 * A broker screenshot → the guess that prefills the phone's Add-option
 * cascade. The bearer twin of `parseOptionScreenshot` in
 * `(app)/options/actions.ts`; see the transaction route beside this one for
 * the shared rationale.
 *
 * The extraction names a contract but does not RESOLVE one — resolving is
 * `POST /api/mobile/v1/import/option/match`, deliberately a second call. The
 * vision read costs money and the match does not, so a user correcting a
 * misread strike re-runs only the free half.
 */
export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, screenshotImportRequestSchema);
  if (!body.ok) return body.response;

  const outcome = await parseOptionScreenshotImage(body.data);
  if (!outcome.ok) return importFailureResponse(outcome.reason);

  return jsonOk({ extraction: outcome.extraction });
}
