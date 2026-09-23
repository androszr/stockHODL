import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {}, dayReports: {} }));
vi.mock('./narrative', () => ({ MODEL: 'test', writeNarrative: vi.fn() }));

import type { DayReportFacts } from './facts';
import { scopeKeyFor } from './kinds';
import type { DayReportNarrativeResponse, StoredDayFigure } from './view-types';
import {
  ensureDayReportNarrative,
  factsFingerprint,
  type NarrativeStoreDependencies,
} from './narrative-store';

const facts = { day: '2026-09-04', kind: 'close' } as DayReportFacts;
const figure: StoredDayFigure = {
  figureDay: '2026-09-04', dayChangePLN: '1234.56', dayChangePct: '0.84', partial: false,
};
const readyNarrative = {
  ok: true as const,
  narrative: {
    portfolioNarrative: 'Portfolio',
    eventsNarrative: 'Events',
    macroNarrative: 'Macro',
    events: [{ date: '2026-09-04', symbol: null, title: 'Jobs report, 08:30 ET' }],
    todayLine: 'Jobs report 08:30',
    sources: [],
  },
};

function storeHarness(
  outcomes: Array<Awaited<ReturnType<NarrativeStoreDependencies['generate']>>>,
) {
  let reservation: { createdAt: Date } | null = null;
  let stored: DayReportNarrativeResponse | null = null;
  const pending: DayReportNarrativeResponse = {
    status: 'pending', portfolioNarrative: null, eventsNarrative: null,
    macroNarrative: null, events: [], todayLine: null, sources: [], staleFigures: false,
  };
  const generate = vi.fn(async () => outcomes.shift() ?? readyNarrative);
  const dependencies: NarrativeStoreDependencies = {
    buildFacts: vi.fn(async () => ({ facts, figure })),
    reserve: vi.fn(async () => {
      if (reservation || stored) return null;
      reservation = { createdAt: new Date() };
      return reservation;
    }),
    read: vi.fn(async () => stored ?? pending),
    generate,
    complete: vi.fn(async (_key, _claim, values) => {
      stored = { ...values, staleFigures: false };
      reservation = null;
    }),
    release: vi.fn(async () => { reservation = null; }),
  };
  return { dependencies, generate };
}

describe('narrative store identity', () => {
  it('hashes identical facts identically', () => {
    const facts = { day: '2026-09-04', kind: 'close' } as DayReportFacts;
    expect(factsFingerprint(facts)).toBe(factsFingerprint({ ...facts }));
  });
  it('changes the hash with figures', () => {
    expect(factsFingerprint({ day: 'A' } as DayReportFacts)).not.toBe(factsFingerprint({ day: 'B' } as DayReportFacts));
  });
  it('uses all for a null scope', () => expect(scopeKeyFor(null)).toBe('all'));
  it('keeps a portfolio scope distinct', () => expect(scopeKeyFor('portfolio-id')).toBe('portfolio-id'));
  it('ignores the stored figure — identical facts hash identically whatever the figure was', () => {
    // The persisted headline travels beside the facts, never inside them: if
    // it leaked in, every existing narrative would flip to staleFigures.
    expect(factsFingerprint(facts)).toBe(factsFingerprint({ ...facts }));
    expect(JSON.stringify(facts)).not.toContain('dayChangePLN');
  });
});

describe('narrative generation reservation', () => {
  it('charges the model once when two callers race for one key', async () => {
    const harness = storeHarness([readyNarrative]);
    const results = await Promise.all([
      ensureDayReportNarrative('u', '2026-09-04', null, 'close', harness.dependencies),
      ensureDayReportNarrative('u', '2026-09-04', null, 'close', harness.dependencies),
    ]);

    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(results.some((result) => result.status === 'ready')).toBe(true);
  });

  it('releases a non-persisted failure so a later request can retry', async () => {
    const harness = storeHarness([
      { ok: false, reason: 'unavailable' },
      readyNarrative,
    ]);

    const first = await ensureDayReportNarrative('u', '2026-09-04', null, 'close', harness.dependencies);
    const second = await ensureDayReportNarrative('u', '2026-09-04', null, 'close', harness.dependencies);

    expect(first.status).toBe('unavailable');
    expect(second.status).toBe('ready');
    expect(harness.generate).toHaveBeenCalledTimes(2);
  });

  it('reserves with the headline figure so the row carries what the report showed', async () => {
    const harness = storeHarness([readyNarrative]);

    await ensureDayReportNarrative('u', '2026-09-04', null, 'close', harness.dependencies);

    expect(harness.dependencies.reserve).toHaveBeenCalledTimes(1);
    const key = vi.mocked(harness.dependencies.reserve).mock.calls[0]?.[0];
    expect(key?.figure?.dayChangePLN).toBe('1234.56');
    expect(key?.figure?.figureDay).toBe('2026-09-04');
    expect(key?.fingerprint).toBe(factsFingerprint(facts));
  });

  it('reserves with a null figure when the view had none', async () => {
    const harness = storeHarness([readyNarrative]);
    vi.mocked(harness.dependencies.buildFacts).mockResolvedValue({ facts, figure: null });

    await ensureDayReportNarrative('u', '2026-09-04', null, 'close', harness.dependencies);

    const key = vi.mocked(harness.dependencies.reserve).mock.calls[0]?.[0];
    expect(key?.figure).toBeNull();
  });

  it('does not reserve or call the model when figures are unavailable', async () => {
    const harness = storeHarness([]);
    vi.mocked(harness.dependencies.buildFacts).mockResolvedValue(null);

    const result = await ensureDayReportNarrative('u', '2026-09-04', null, 'close', harness.dependencies);

    expect(result.status).toBe('unavailable');
    expect(harness.dependencies.reserve).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });
});
