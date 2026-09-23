import {
  screenshotImportRequestSchema,
  transactionImportResponseSchema,
} from '@/lib/api/contracts';
import { importFailureResponse } from '@/lib/api/mobile/import-respond';
import { jsonOk, parseJsonBody, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { parseTransactionScreenshotImage } from '@/lib/screenshots/parse';
import { buildTransactionPrefill } from '@/lib/screenshots/transaction-prefill';

/**
 * A broker screenshot → the guess that prefills the phone's Add-transaction
 * form. The bearer twin of `parseTransactionScreenshot` in
 * `(app)/transactions/actions.ts`, sharing its whole body through
 * `src/lib/screenshots/parse.ts` — including the order of the gates, which is
 * the security and cost story of this route.
 *
 * READ-ONLY. Nothing here writes a transaction: the extraction goes back to
 * the form, the user reads it, and the ordinary
 * `POST /api/mobile/v1/transactions` does the write with the ordinary
 * validation. One place a transaction can be created, on both surfaces.
 *
 * The session guard runs BEFORE any byte of the upload is inspected — this
 * route turns an image into a paid vendor call, and an unauthenticated
 * request must not be able to reach even the free local gates.
 */
export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, screenshotImportRequestSchema);
  if (!body.ok) return body.response;

  const outcome = await parseTransactionScreenshotImage(body.data);
  if (!outcome.ok) return importFailureResponse(outcome.reason);

  // The PREFILL, not the extraction: the currency inference, the fee
  // conversion and the side resolution are the hard part, and they stay in
  // one implementation rather than being ported to Swift and kept in step.
  const prefill = buildTransactionPrefill(outcome.extraction);
  const { form, ...rest } = prefill;
  return jsonOk(transactionImportResponseSchema.parse({ ...rest, formPrefill: form }));
}
