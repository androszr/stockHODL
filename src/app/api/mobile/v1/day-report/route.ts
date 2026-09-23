import { dayReportQuerySchema, dayReportResponseSchema } from '@/lib/api/contracts';
import { jsonOk, parseQuery, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId as userIdForSession } from '@/lib/api/mobile/session';
import { getDayReportView } from '@/lib/day-report/view';

export async function GET(request: Request) {
  const userId = await userIdForSession(request);
  if (!userId) return unauthorized();
  const query = parseQuery(request, dayReportQuerySchema);
  if (!query.ok) return query.response;
  return jsonOk(
    dayReportResponseSchema.parse(
      await getDayReportView(userId, {
        day: query.data.day,
        kind: query.data.kind ?? 'close',
        portfolioId: query.data.p,
      }),
    ),
  );
}
