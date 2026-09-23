import { z } from 'zod';

import { MAX_IMPORT_IMAGE_BASE64_LENGTH } from '@/lib/screenshots/image-upload';
import { optionScreenshotExtractionSchema } from '@/lib/validation';

/**
 * Screenshot import — the one mobile surface that SPENDS MONEY per request.
 *
 * Every field the vision model fills is nullable, and that is the whole
 * design: an extraction is a GUESS that prefills a form the user still has to
 * read and save. Nothing here writes anything. The phone reuses the ordinary
 * add-transaction and add-option paths for the write, exactly as the web's
 * `transaction-import.tsx` does — one Save button, one set of validation
 * rules, one place a position can be created.
 *
 * The extraction schemas themselves are NOT redefined here. They are imported
 * verbatim from `validation.ts`, where the vision prompt's field list lives:
 * a second copy would drift from the prompt on the first field added, and the
 * drift would be silent — the model would keep returning a field no client
 * knew to render.
 */

/**
 * Request body for both importers.
 *
 * Base64 in a JSON body rather than multipart: the server gate
 * (`decodeUploadedImage`) is written against a base64 string and is shared
 * with the web's Server Action, and a second intake shape would mean a second
 * gate. The cost is ~33% more bytes on the wire, which the client-side
 * downscale to `maxLongEdgePx` more than pays back.
 */
export const screenshotImportRequestSchema = z.object({
  imageBase64: z.string().min(1).max(MAX_IMPORT_IMAGE_BASE64_LENGTH),
});

export type ScreenshotImportRequest = z.output<typeof screenshotImportRequestSchema>;

/**
 * Why a parse did not happen, in the server's vocabulary.
 *
 * Carried as a CODE rather than only a sentence because the two clients word
 * these differently and one of them (`rate_limited`) has to be distinguishable
 * to decide whether retrying is even worth offering. `signed-out` is absent:
 * on this wire that is a 401, and the client already has one place that
 * handles those.
 */
export const screenshotImportFailureSchema = z.enum([
  'rate_limited',
  'invalid_image',
  'not_configured',
  'refused',
  'unparseable',
  'unavailable',
]);

export type ScreenshotImportFailure = z.output<typeof screenshotImportFailureSchema>;

/**
 * A prefill NOTE — every inference this app made and is disclosing.
 *
 * FLAT, with the union's members as optional fields, rather than a
 * discriminated union: quicktype turns a TS union into a nest of one-field
 * Swift enums that no view can read, and this payload exists to be rendered.
 * `kind` is still the discriminant; a client switches on it and reads the
 * fields that kind carries.
 *
 * The WORDING is not on the wire, only the facts. Each surface writes its own
 * sentences — the same split as every other screen in the port. What must not
 * diverge is which notes exist and when they fire, and that is decided once,
 * in `buildTransactionPrefill`.
 */
export const prefillNoteSchema = z.object({
  kind: z.enum([
    'position',
    'side-assumed',
    'side-unknown',
    'fee-converted',
    'fee-unconverted',
    'price-currency-inferred',
    'currency-mismatch',
    'total-mismatch',
  ]),
  quantity: z.string().nullable().optional(),
  pricePerShare: z.string().nullable().optional(),
  feeCurrency: z.string().nullable().optional(),
  /** `fee-unconverted` only: 'no-rate' vs 'unknown-target'. The two must not
   *  share a sentence — see the note on `PrefillNote`. */
  reason: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  screenCurrency: z.string().nullable().optional(),
  /** `fee-converted` only: the arithmetic, so the user can check it. */
  shown: z
    .object({
      from: z.string(),
      fromCurrency: z.string(),
      rate: z.string(),
      to: z.string(),
      toCurrency: z.string(),
    })
    .nullable()
    .optional(),
});

export type PrefillNoteContract = z.output<typeof prefillNoteSchema>;

/**
 * The transaction importer answers with the PREFILL, not the raw extraction.
 *
 * `buildTransactionPrefill` is where the genuinely hard decisions live —
 * which side the screen means, which currency the price is really in when the
 * screen mislabels it, whether a złoty commission can be converted into a
 * dollar field. Those are the rules a broker screenshot exists to defeat, and
 * shipping the extraction instead would have meant porting all of them to
 * Swift and then keeping two copies honest. The phone gets the answer.
 */
export const transactionImportResponseSchema = z.object({
  /**
   * Named `formPrefill`, not `form`: quicktype names a nested object after its
   * KEY, and a generated `struct Form` shadows SwiftUI's `Form` in every file
   * that imports the contracts — which is every screen. The generated names
   * are part of this schema's contract with the client, so the key is chosen
   * with them in mind.
   */
  formPrefill: z.object({
    quantity: z.string().nullable(),
    price: z.string().nullable(),
    fees: z.string().nullable(),
    tradeDate: z.string().nullable(),
    side: z.enum(['buy', 'sell']).nullable(),
    /** Typed into the symbol search box for the user to act on. Never a pick:
     *  resolving a company to an instrument stays an explicit tap. */
    symbolQuery: z.string().nullable(),
  }),
  /** Field labels READ off the picture, for the honesty list. */
  readFields: z.array(z.string()),
  notes: z.array(prefillNoteSchema),
  companyName: z.string().nullable(),
  isin: z.string().nullable(),
  screenKind: z.enum(['transaction', 'position']).nullable(),
  priceCurrency: z.string().nullable(),
  priceCurrencyTrusted: z.boolean(),
});

export type TransactionImportResponse = z.output<typeof transactionImportResponseSchema>;

export const optionImportResponseSchema = z.object({
  extraction: optionScreenshotExtractionSchema,
});

export type OptionImportResponse = z.output<typeof optionImportResponseSchema>;

/**
 * The failure body. It is answered with a non-2xx status, so it also carries
 * `error` — the one shape every mobile endpoint uses for a sentence — and
 * `reason` on top of it for the cases the client branches on.
 */
export const screenshotImportErrorSchema = z.object({
  error: z.string(),
  reason: screenshotImportFailureSchema,
});

export type ScreenshotImportError = z.output<typeof screenshotImportErrorSchema>;
