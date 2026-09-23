import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The closing-summary cron's readiness gate, over mocked collaborators
 * (nothing here touches Neon or APNs;
 * plans/2026-09-23-report-push-waits-for-report.md): the push deep-links to
 * the close report, so it goes out only once that report is COMPLETE
 * (`ready` or `refused`). While the report is pending, missing or failed the
 * run sends nothing, writes no never-twice marker — so a later slot retries —
 * and counts the held push in `notReady`.
 */

const h = vi.hoisted(() => ({
  users: [] as Array<{
    userId: string;
    dailySummary: boolean;
    dailySummaryLastSentDay: string | null;
    morningBriefLastSentDay: string | null;
  }>,
  ensureNarrative: vi.fn(),
  sendPush: vi.fn(),
  markSent: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: () => ({ CRON_SECRET: 'secret' }) }));
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => [{ token: 'tok-1' }]) })),
    })),
  },
  pushTokens: { token: 'token', userId: 'user_id' },
}));
vi.mock('@/lib/market-data/calendar-store', () => ({
  readStoredCalendar: async () => ({ ok: true, overrides: [], knownFromISO: null }),
}));
vi.mock('@/lib/push/daily-summary', () => ({
  dailySummaryDayToSend: () => '2026-09-21',
  composeDailySummaryAlert: () => ({
    title: 'Portfolio today',
    body: '+1 zł',
    urlScheme: 'stockhodl://day-report/2026-09-21?kind=close',
  }),
}));
vi.mock('@/lib/holdings/live-view', () => ({
  loadHoldingsInputs: async () => ({ rows: [], quotes: new Map(), inputs: { fxRates: new Map() } }),
}));
vi.mock('@/lib/position-engine', () => ({
  computePositions: () => [],
  displayablePositions: (positions: unknown) => positions,
}));
vi.mock('@/lib/holdings/summary', () => ({ computePortfolioSummary: () => ({}) }));
vi.mock('@/lib/day-report/narrative-store', () => ({
  ensureDayReportNarrative: h.ensureNarrative,
}));
vi.mock('@/lib/push/apns', () => ({ sendPushAlert: h.sendPush }));
vi.mock('@/lib/push/tokens', () => ({ pruneInvalidTokens: vi.fn() }));
vi.mock('@/lib/push/preferences', () => ({
  listDayReportUsers: async () => h.users,
  markDailySummarySent: h.markSent,
}));

import { GET } from './route';

const DAY = '2026-09-21';

const request = () =>
  new Request('http://localhost/api/cron/daily-summary', {
    headers: { authorization: 'Bearer secret' },
  });

const switchOn = () => [
  { userId: 'u1', dailySummary: true, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
];

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy?.mockRestore();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.users = [];
  h.ensureNarrative.mockReset().mockResolvedValue({ status: 'ready' });
  h.sendPush.mockReset().mockResolvedValue(new Map([['tok-1', 'delivered']]));
  h.markSent.mockReset();
});

describe('daily-summary cron', () => {
  it('a ready report sends the push and marks it sent', async () => {
    h.users = switchOn();

    const body = await (await GET(request())).json();

    expect(h.ensureNarrative).toHaveBeenCalledWith('u1', DAY, null, 'close');
    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect(h.sendPush.mock.calls[0][1]).toMatchObject({ title: 'Portfolio today' });
    expect(h.markSent).toHaveBeenCalledWith('u1', DAY);
    expect(body).toEqual({ ok: true, day: DAY, reports: 1, sent: 1, notReady: 0 });
  });

  it('a refused report is complete: sends and marks', async () => {
    h.users = switchOn();
    h.ensureNarrative.mockResolvedValue({ status: 'refused' });

    const body = await (await GET(request())).json();

    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect(h.markSent).toHaveBeenCalledWith('u1', DAY);
    expect(body).toEqual({ ok: true, day: DAY, reports: 1, sent: 1, notReady: 0 });
  });

  it('a pending report holds the push: no send, no marker', async () => {
    h.users = switchOn();
    h.ensureNarrative.mockResolvedValue({ status: 'pending' });

    const body = await (await GET(request())).json();

    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('held u1'));
    expect(body).toEqual({ ok: true, day: DAY, reports: 0, sent: 0, notReady: 1 });
  });

  it('an unavailable report holds the push', async () => {
    h.users = switchOn();
    h.ensureNarrative.mockResolvedValue({ status: 'unavailable' });

    const body = await (await GET(request())).json();

    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('held u1'));
    expect(body).toEqual({ ok: true, day: DAY, reports: 0, sent: 0, notReady: 1 });
  });

  it('a not_configured report (no writer key) does not hold: sends and marks', async () => {
    h.users = switchOn();
    h.ensureNarrative.mockResolvedValue({ status: 'not_configured' });

    const body = await (await GET(request())).json();

    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect(h.markSent).toHaveBeenCalledWith('u1', DAY);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, day: DAY, reports: 0, sent: 1, notReady: 0 });
  });

  it('a failed narrative write holds the push', async () => {
    h.users = switchOn();
    h.ensureNarrative.mockRejectedValue(new Error('model down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const body = await (await GET(request())).json();

    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('held u1'));
    expect(body).toEqual({ ok: true, day: DAY, reports: 0, sent: 0, notReady: 1 });
    errorSpy.mockRestore();
  });

  it('a pending report for an account with the switch OFF counts as nothing held', async () => {
    h.users = [
      { userId: 'u1', dailySummary: false, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
    ];
    h.ensureNarrative.mockResolvedValue({ status: 'pending' });

    const body = await (await GET(request())).json();

    expect(h.ensureNarrative).toHaveBeenCalledWith('u1', DAY, null, 'close');
    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, day: DAY, reports: 0, sent: 0, notReady: 0 });
  });

  it('a ready report already pushed today sends nothing more', async () => {
    h.users = [
      { userId: 'u1', dailySummary: true, dailySummaryLastSentDay: DAY, morningBriefLastSentDay: null },
    ];

    const body = await (await GET(request())).json();

    expect(h.ensureNarrative).toHaveBeenCalledTimes(1);
    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, day: DAY, reports: 1, sent: 0, notReady: 0 });
  });
});
