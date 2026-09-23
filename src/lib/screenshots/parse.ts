import 'server-only';

import { z } from 'zod';

import {
  extractOptionScreenshot,
  extractTransactionScreenshot,
  type ExtractFailure,
  type ExtractImage,
} from '@/lib/ai/vision-extract';
import { normalizeExtraction } from '@/lib/options/screenshot-parse';
import {
  decodeUploadedImage,
  MAX_IMPORT_IMAGE_BASE64_LENGTH,
  type ScreenshotParseFailure,
} from '@/lib/screenshots/image-upload';
import { normalizeTransactionExtraction } from '@/lib/screenshots/transaction-prefill';
import { visionRateLimited } from '@/lib/screenshots/vision-rate-limit';
import {
  optionScreenshotExtractionSchema,
  transactionScreenshotExtractionSchema,
  type OptionScreenshotExtraction,
  type TransactionScreenshotExtraction,
} from '@/lib/validation';

/**
 * The screenshot-import pipeline, owned here rather than in a Server Action.
 *
 * It moved when the phone got an importer (2026-08-18). The two actions in
 * `(app)/transactions/actions.ts` and `(app)/options/actions.ts` had carried
 * two copies of the SAME gate ladder, and the mobile routes would have made
 * four. That ladder is not incidental code: it is the whole security and
 * cost story of a route that turns an uploaded image into a paid vendor
 * call, and its ORDER is load-bearing. Four copies of a load-bearing order is
 * three too many.
 *
 * Authentication is NOT here, deliberately — it is the one step that differs
 * between a Server Action (cookie session) and a mobile route (bearer), and
 * every caller does it FIRST, before handing a single byte to this module.
 *
 * The order below, and why each step sits where it does:
 *  (a) strict base64 length/alphabet, decode, decoded-size cap, magic-byte
 *      sniff — all inside `decodeUploadedImage`, all free, all before the
 *      vendor is touched. The SNIFFED media type is what goes onward; the
 *      client's claim about the file is never read anywhere in this path.
 *  (b) the rate limit, consumed AFTER those free gates and immediately before
 *      the paid call. The budget is ONE in-process allowance shared by both
 *      importers and now by both surfaces, so charging it for a payload that
 *      never reaches the vendor would let malformed uploads on one screen
 *      lock the other three out for ten minutes.
 *  (c) the vision call.
 *  (d) normalization, then a re-validation of the model's own output against
 *      its own schema — belt as well as braces. A shape that fails is
 *      `unparseable`, never a crash and never a half-filled form.
 *
 * Every rejection before (c) collapses to one indistinguishable
 * `invalid_image`, so a probe learns nothing about which check it tripped.
 */

const inputSchema = z.object({
  imageBase64: z.string().min(1).max(MAX_IMPORT_IMAGE_BASE64_LENGTH),
});

export type ScreenshotParseOutcome<T> =
  | { ok: true; extraction: T }
  | { ok: false; reason: ScreenshotParseFailure };

/**
 * `error` is the vendor being unreachable or answering nonsense — a state of
 * the world, not of the request — and the surfaces say "try again" for it.
 * Every other failure already names itself.
 */
function failureFrom(reason: ExtractFailure): ScreenshotParseFailure {
  return reason === 'error' ? 'unavailable' : reason;
}

async function parseScreenshot<T>(
  input: unknown,
  extract: (image: ExtractImage) => Promise<
    { ok: true; extraction: unknown } | { ok: false; reason: ExtractFailure }
  >,
  normalize: (extraction: never) => unknown,
  schema: z.ZodType<T>,
): Promise<ScreenshotParseOutcome<T>> {
  const parsedInput = inputSchema.safeParse(input);
  if (!parsedInput.success) return { ok: false, reason: 'invalid_image' };

  const base64 = parsedInput.data.imageBase64;
  const decoded = decodeUploadedImage(base64);
  if (decoded === null) return { ok: false, reason: 'invalid_image' };

  if (visionRateLimited(Date.now())) return { ok: false, reason: 'rate_limited' };

  const outcome = await extract({ data: base64, mediaType: decoded.mediaType });
  if (!outcome.ok) return { ok: false, reason: failureFrom(outcome.reason) };

  // The normalizers index into the extraction's fields directly. Today
  // `vision-extract` schema-checks the model's answer before returning it, so
  // they are safe — but that is a guarantee made two modules away, and this
  // is the boundary that consumes MODEL OUTPUT. A shape nobody anticipated
  // must degrade to `unparseable`, which is what the caller already handles,
  // rather than throw past every surface as a 500.
  let normalized: unknown;
  try {
    normalized = normalize(outcome.extraction as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'normalize failed';
    console.error(`Screenshot normalization failed: ${message}`);
    return { ok: false, reason: 'unparseable' };
  }

  const revalidated = schema.safeParse(normalized);
  if (!revalidated.success) return { ok: false, reason: 'unparseable' };

  return { ok: true, extraction: revalidated.data };
}

/** A broker screenshot → the guess that prefills the Add-transaction form. */
export function parseTransactionScreenshotImage(
  input: unknown,
): Promise<ScreenshotParseOutcome<TransactionScreenshotExtraction>> {
  return parseScreenshot(
    input,
    extractTransactionScreenshot,
    normalizeTransactionExtraction,
    transactionScreenshotExtractionSchema,
  );
}

/** A broker screenshot → the guess that prefills the Add-option cascade. */
export function parseOptionScreenshotImage(
  input: unknown,
): Promise<ScreenshotParseOutcome<OptionScreenshotExtraction>> {
  return parseScreenshot(
    input,
    extractOptionScreenshot,
    normalizeExtraction,
    optionScreenshotExtractionSchema,
  );
}
