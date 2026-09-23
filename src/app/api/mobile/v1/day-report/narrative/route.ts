import {
  dayReportNarrativeRequestSchema,
  dayReportNarrativeResponseSchema,
} from '@/lib/api/contracts';
import { jsonOk, parseJsonBody, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId as userIdForSession } from '@/lib/api/mobile/session';
import { ensureDayReportNarrative } from '@/lib/day-report/narrative-store';
import { resolvePortfolioScope } from '@/lib/holdings/scope';

export async function POST(request: Request) {
  const userId = await userIdForSession(request);
  if (!userId) return unauthorized();
  const body = await parseJsonBody(request, dayReportNarrativeRequestSchema);
  if (!body.ok) return body.response;
  const scope = await resolvePortfolioScope(userId, body.data.p);
  return jsonOk(
    dayReportNarrativeResponseSchema.parse({
      narrative: await ensureDayReportNarrative(userId, body.data.day, scope, body.data.kind),
    }),
  );
}
