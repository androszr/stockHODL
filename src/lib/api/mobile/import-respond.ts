import type { ScreenshotImportFailure } from '@/lib/api/contracts';
import type { ScreenshotParseFailure } from '@/lib/screenshots/image-upload';

/**
 * One screenshot-parse failure → one HTTP answer, for both import routes.
 *
 * The body carries BOTH `error` (the sentence every mobile endpoint answers
 * with, so the generic client error path has something to show) and `reason`
 * (the code, so the importer can branch). The client branches on exactly one
 * of them today — `rate_limited`, because it is the only failure where
 * retrying immediately is guaranteed to fail and the copy has to say so —
 * but the code is cheap and matching on a sentence is a bug awaiting a
 * reword.
 *
 * The statuses are chosen so a caller with no knowledge of this app still
 * reads them correctly: 429 means wait, 5xx means not your fault, 4xx means
 * fix the request. `unparseable` and `refused` are 422 rather than 400: the
 * upload was a valid image and a valid request — it just was not a broker
 * screenshot this model could read.
 */
const STATUS: Record<ScreenshotParseFailure, number> = {
  'signed-out': 401,
  rate_limited: 429,
  invalid_image: 400,
  not_configured: 503,
  refused: 422,
  unparseable: 422,
  unavailable: 503,
};

const SENTENCE: Record<ScreenshotParseFailure, string> = {
  'signed-out': 'Not signed in.',
  rate_limited:
    'Too many reads in a short time — each one costs real money. Wait a few minutes.',
  invalid_image: 'That file is not a supported image (PNG, JPEG or WebP).',
  not_configured: 'Screenshot import is not configured on the server.',
  refused: 'The reader would not process that picture.',
  unparseable: 'Nothing readable was found in that screenshot.',
  unavailable: 'The reader is unavailable right now. Try again in a moment.',
};

export function importFailureResponse(reason: ScreenshotParseFailure): Response {
  return Response.json(
    { error: SENTENCE[reason], reason: reason as ScreenshotImportFailure },
    { status: STATUS[reason], headers: { 'Cache-Control': 'private, no-store' } },
  );
}
