import { dayReportHistoryQuerySchema, dayReportHistoryResponseSchema } from '@/lib/api/contracts';
import { jsonOk, parseQuery, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId as userIdForSession } from '@/lib/api/mobile/session';
import { listDayReportHistory } from '@/lib/day-report/history';

export async function GET(request: Request) {
  const userId = await userIdForSession(request);
  if (!userId) return unauthorized();
  const query = parseQuery(request, dayReportHistoryQuerySchema);
  if (!query.ok) return query.response;
  return jsonOk(
    dayReportHistoryResponseSchema.parse(await listDayReportHistory(userId, query.data.cursor)),
  );
}
