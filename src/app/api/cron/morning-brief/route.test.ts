import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The morning-brief cron's one load-bearing rule, over mocked collaborators
 * (nothing here touches Neon or APNs): the REPORT is written for every
 * account, and the "Daily summary" switch decides only whether a PUSH goes
 * out. The regression this pins: the loop used to walk only opted-in users,
 * so an account with pushes off never got a morning report at all — nothing
 * in `day_reports`, nothing on the Day Report screen, nothing in the history.
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

const FACTS = {
  recap: { dayChange: { text: '+1 zł', direction: 'up' }, dayChangePct: '+0.1%' },
  headlines: [],
  events: { items: [], earningsCaption: '' },
};

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
  morningBriefDayToSend: () => '2026-09-21',
  dayReportUrlScheme: (day: string, kind: string) => `stockhodl://day-report/${day}?kind=${kind}`,
}));
vi.mock('@/lib/day-report/view', () => ({
  buildFactsForNarrative: async () => ({ facts: FACTS, figure: null }),
}));
vi.mock('@/lib/day-report/narrative-store', () => ({
  ensureDayReportNarrative: h.ensureNarrative,
}));
vi.mock('@/lib/push/apns', () => ({ sendPushAlert: h.sendPush }));
vi.mock('@/lib/push/tokens', () => ({ pruneInvalidTokens: vi.fn() }));
vi.mock('@/lib/push/preferences', () => ({
  listDayReportUsers: async () => h.users,
  markMorningBriefSent: h.markSent,
}));

import { GET } from './route';

const request = () =>
  new Request('http://localhost/api/cron/morning-brief', {
    headers: { authorization: 'Bearer secret' },
  });

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy?.mockRestore();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.users = [];
  h.ensureNarrative.mockReset().mockResolvedValue({ status: 'ready' });
  h.sendPush.mockReset().mockResolvedValue(new Map([['tok-1', 'delivered']]));
  h.markSent.mockReset();
});

describe('morning-brief cron', () => {
  it('writes the report for an account whose push switch is OFF, and sends nothing', async () => {
    h.users = [
      { userId: 'u1', dailySummary: false, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
    ];

    const body = await (await GET(request())).json();

    expect(h.ensureNarrative).toHaveBeenCalledWith('u1', '2026-09-21', null, 'morning');
    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, day: '2026-09-21', reports: 1, sent: 0, notReady: 0 });
  });

  it('writes the report AND pushes for an account whose switch is ON', async () => {
    h.users = [
      { userId: 'u1', dailySummary: true, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
    ];

    const body = await (await GET(request())).json();

    expect(h.ensureNarrative).toHaveBeenCalledTimes(1);
    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect(h.sendPush.mock.calls[0][1]).toMatchObject({ title: 'Before the open' });
    expect(h.markSent).toHaveBeenCalledWith('u1', '2026-09-21');
    expect(body).toEqual({ ok: true, day: '2026-09-21', reports: 1, sent: 1, notReady: 0 });
  });

  it('still writes the report when today\'s push was already delivered', async () => {
    h.users = [
      {
        userId: 'u1',
        dailySummary: true,
        dailySummaryLastSentDay: null,
        morningBriefLastSentDay: '2026-09-21',
      },
    ];

    const body = await (await GET(request())).json();

    expect(h.ensureNarrative).toHaveBeenCalledTimes(1);
    expect(h.sendPush).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, day: '2026-09-21', reports: 1, sent: 0, notReady: 0 });
  });

  it('a failed narrative HOLDS the push: no send, no marker', async () => {
    h.users = [
      { userId: 'u1', dailySummary: true, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
    ];
    h.ensureNarrative.mockRejectedValue(new Error('model down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const body = await (await GET(request())).json();

    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('held u1'));
    expect(body).toEqual({ ok: true, day: '2026-09-21', reports: 0, sent: 0, notReady: 1 });
    errorSpy.mockRestore();
  });

  it('a pending report holds the push: no send, no marker', async () => {
    h.users = [
      { userId: 'u1', dailySummary: true, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
    ];
    h.ensureNarrative.mockResolvedValue({ status: 'pending' });

    const body = await (await GET(request())).json();

    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('held u1'));
    expect(body).toEqual({ ok: true, day: '2026-09-21', reports: 0, sent: 0, notReady: 1 });
  });

  it('a refused report still sends the recap line', async () => {
    h.users = [
      { userId: 'u1', dailySummary: true, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
    ];
    h.ensureNarrative.mockResolvedValue({ status: 'refused', todayLine: null });

    const body = await (await GET(request())).json();

    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect(h.sendPush.mock.calls[0][1]).toMatchObject({ body: 'Yesterday: +1 zł (+0.1%)' });
    expect(h.markSent).toHaveBeenCalledWith('u1', '2026-09-21');
    expect(body).toEqual({ ok: true, day: '2026-09-21', reports: 1, sent: 1, notReady: 0 });
  });

  it('a not_configured report (no writer key) does not hold: sends the recap alone', async () => {
    h.users = [
      { userId: 'u1', dailySummary: true, dailySummaryLastSentDay: null, morningBriefLastSentDay: null },
    ];
    h.ensureNarrative.mockResolvedValue({ status: 'not_configured', todayLine: 'ignored' });

    const body = await (await GET(request())).json();

    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect(h.sendPush.mock.calls[0][1]).toMatchObject({ body: 'Yesterday: +1 zł (+0.1%)' });
    expect(h.markSent).toHaveBeenCalledWith('u1', '2026-09-21');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, day: '2026-09-21', reports: 0, sent: 1, notReady: 0 });
  });
});
