import { dividendInstrumentListSchema } from '@/lib/api/contracts';
import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { listTransactedInstruments } from '@/lib/dividends/mutations';
import { listPortfolios } from '@/lib/portfolios/mutations';

/**
 * What a manual payment may attach to: the user's own transacted instruments
 * and their portfolios — the two dropdowns of the web's `/dividends/new`,
 * as one read.
 *
 * One request rather than two because the form needs both before it can
 * render at all, and a phone pays the round trip twice if they queue. An
 * empty list on either side is a real answer — it means "record a
 * transaction first", which is what the form then says.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const [instruments, portfolios] = await Promise.all([
    listTransactedInstruments(userId),
    listPortfolios(userId),
  ]);

  return jsonOk(
    dividendInstrumentListSchema.parse({
      instruments,
      portfolios: portfolios.map((p) => ({ id: p.id, name: p.name })),
    }),
  );
}
