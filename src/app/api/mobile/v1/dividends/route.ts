import { dividendsResponseSchema } from '@/lib/api/contracts';
import {
  jsonError,
  jsonOk,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { createDividendFor } from '@/lib/dividends/mutations';
import { dividendCreateSchema } from '@/lib/dividends/validation';
import { groupPaymentsByYear, summarizeDividends } from '@/lib/dividends/summary';
import { loadDividendsView, warsawTodayISO } from '@/lib/dividends/view';
import { dec, toNumeric } from '@/lib/money';

/**
 * Every dividend the ledger has recorded, grouped by year — the phone's read
 * of `/dividends`, over the same `loadDividendsView` (including its
 * first-visit sync) and the same pure fold the page uses. The two surfaces
 * agree by construction rather than by two people keeping two sums in step.
 *
 * `?p=` scopes to a portfolio and `?symbol=` to an instrument, both resolved
 * inside the shared view: a malformed, foreign or unknown value degrades to
 * the unfiltered list rather than erroring, so neither parameter can be used
 * to enumerate anything.
 *
 * `POST` adds a MANUAL payment — the remedy for anything the ledger cannot
 * derive. It validates with `dividendCreateSchema`, the same isomorphic
 * schema the web form submits through, and writes through
 * `src/lib/dividends/mutations.ts`, the same module the Server Action calls.
 * There is one implementation of this record, and both clients use it.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const url = new URL(request.url);
  const { rows } = await loadDividendsView(userId, {
    portfolioIdParam: url.searchParams.get('p') ?? undefined,
    symbol: url.searchParams.get('symbol') ?? undefined,
  });

  const summary = summarizeDividends(rows, warsawTodayISO()).all;
  const years = groupPaymentsByYear(rows);

  return jsonOk(
    dividendsResponseSchema.parse({
      payments: rows.map((row) => ({
        id: row.id,
        portfolioId: row.portfolioId,
        portfolioName: row.portfolioName,
        instrumentId: row.instrumentId,
        symbol: row.symbol,
        displayName: row.displayName,
        exDate: row.exDate,
        payDate: row.payDate,
        quantity: row.quantity,
        amountPerShare: row.amountPerShare,
        grossAmount: row.grossAmount,
        withheldTax: row.withheldTax,
        // Derived HERE, on Decimal, so the phone never subtracts two money
        // strings of its own — the one rule this payload exists to protect.
        netAmount: toNumeric(dec(row.grossAmount).minus(dec(row.withheldTax))),
        currency: row.currency,
        fxRateToBase: row.fxRateToBase,
        source: row.source,
        edited: row.edited,
        note: row.note,
      })),
      years: years.map((group) => ({
        year: group.year,
        // Ids rather than nested rows: a five-year history is the ordinary
        // case here, and repeating every payment inside its year would double
        // the payload for nothing the client cannot join in one pass.
        paymentIds: group.rows.map((row) => row.id),
        totals: group.totals,
        netPLN: group.netPLN,
        awaitingFx: group.awaitingFx,
        fxUnsupported: group.fxUnsupported,
      })),
      summary,
    }),
  );
}

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, dividendCreateSchema);
  if (!body.ok) return body.response;

  const result = await createDividendFor(userId, body.data);
  // An unowned portfolio and an instrument the user never traded are the
  // user's mistake rather than a malformed request: 409, so the client can
  // show the refusal verbatim beside the field.
  if (!result.ok) return jsonError(result.error, 409);

  return jsonOk({ ok: true }, 201);
}
