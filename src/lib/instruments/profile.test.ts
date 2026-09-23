import { describe, expect, it, vi } from 'vitest';

import type { TickerProfile, TickerProfileOutcome } from '@/lib/market-data/provider';

/**
 * The staleness gate, the fan-out bound and the stamp-on-null rule, run
 * against a fake IO — the injectable seam exists precisely so this is
 * testable without mocking Drizzle chains (the `price-history.test.ts`
 * arrangement). The framework boundaries are stubbed only so the module can
 * be imported at all.
 */
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {}, instruments: {} }));
vi.mock('@/lib/market-data/massive', () => ({ massiveProvider: {} }));

import {
  MAX_PROFILE_SYNC,
  syncInstrumentProfilesWith,
  type ProfileCandidate,
  type ProfileIO,
} from './profile';

const NOW = new Date('2026-08-18T12:00:00Z');

const emptyProfile = {
  description: null,
  homepageUrl: null,
  sector: null,
  sharesOutstanding: null,
  sicCode: null,
  totalEmployees: null,
} satisfies TickerProfile;

interface Saved {
  id: string;
  profile: TickerProfile | null;
  syncedAt: Date;
}

function fakeIO(
  candidates: ProfileCandidate[],
  fetch: (symbol: string) => Promise<TickerProfileOutcome> = async () => ({
    ok: false,
    reason: 'not_found',
  }),
): { io: ProfileIO; saved: Saved[]; asked: string[]; staleBefore: Date[] } {
  const saved: Saved[] = [];
  const asked: string[] = [];
  const staleBefore: Date[] = [];
  return {
    saved,
    asked,
    staleBefore,
    io: {
      async listStale(_ids, before) {
        staleBefore.push(before);
        return candidates;
      },
      async fetchProfile(symbol) {
        asked.push(symbol);
        return fetch(symbol);
      },
      async save(id, profile, syncedAt) {
        saved.push({ id, profile, syncedAt });
      },
    },
  };
}

describe('syncInstrumentProfiles', () => {
  it('does nothing for an empty id list', async () => {
    const { io, asked } = fakeIO([{ id: 'i1', symbol: 'AAPL' }]);
    await syncInstrumentProfilesWith(io, [], NOW);
    expect(asked).toEqual([]);
  });

  it('asks the store for rows last synced over 30 days ago', async () => {
    const { io, staleBefore } = fakeIO([]);
    await syncInstrumentProfilesWith(io, ['i1'], NOW);
    expect(staleBefore[0].toISOString()).toBe('2026-07-19T12:00:00.000Z');
  });

  it('skips everything when the store returns no stale rows', async () => {
    // A fresh `profile_synced_at` never reaches the vendor: the gate is SQL,
    // and an empty candidate list is what "nothing to do" looks like here.
    const { io, asked, saved } = fakeIO([]);
    await syncInstrumentProfilesWith(io, ['i1', 'i2'], NOW);
    expect(asked).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('syncs a row the store named as stale', async () => {
    const profile: TickerProfile = {
      sector: 'Electronic Computers',
      sicCode: '3571',
      description: 'Apple designs consumer electronics.',
      totalEmployees: 164000,
      homepageUrl: 'https://www.apple.com',
      sharesOutstanding: '15101622000',
    };
    const { io, asked, saved } = fakeIO([{ id: 'i1', symbol: 'AAPL' }], async () => ({
      ok: true,
      profile,
    }));
    await syncInstrumentProfilesWith(io, ['i1'], NOW);
    expect(asked).toEqual(['AAPL']);
    expect(saved).toEqual([{ id: 'i1', profile, syncedAt: NOW }]);
  });

  it('holds the MAX_PROFILE_SYNC bound even if the store over-answers', async () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      id: `i${i}`,
      symbol: `S${i}`,
    }));
    const { io, asked } = fakeIO(candidates);
    await syncInstrumentProfilesWith(io, candidates.map((c) => c.id), NOW);
    expect(asked).toHaveLength(MAX_PROFILE_SYNC);
  });

  it('stamps the timestamp even when the vendor answers nothing', async () => {
    // The rule that stops a permanently unclassifiable ticker from being
    // re-asked on every page load forever. `profile: null` is STAMP ONLY —
    // the columns are left as they were.
    const { io, saved } = fakeIO([{ id: 'i1', symbol: 'CDR.WA' }], async () => ({
      ok: false,
      reason: 'not_found',
    }));
    await syncInstrumentProfilesWith(io, ['i1'], NOW);
    expect(saved).toEqual([{ id: 'i1', profile: null, syncedAt: NOW }]);
  });

  it('writes a vendor answer that carries no industry, nulls and all', async () => {
    // ASML and SPY probe as `sic_description: null`: the vendor KNOWS the
    // ticker and lists no industry, which is an answer, not a failure.
    const { io, saved } = fakeIO([{ id: 'i1', symbol: 'SPY' }], async () => ({
      ok: true,
      profile: emptyProfile,
    }));
    await syncInstrumentProfilesWith(io, ['i1'], NOW);
    expect(saved).toEqual([{ id: 'i1', profile: emptyProfile, syncedAt: NOW }]);
  });

  it('swallows and logs a thrown vendor error, leaving the row alone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { io, saved } = fakeIO([{ id: 'i1', symbol: 'AAPL' }], async () => {
        throw new Error('vendor exploded');
      });
      await expect(syncInstrumentProfilesWith(io, ['i1'], NOW)).resolves.toBeUndefined();
      expect(saved).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain('vendor exploded');
    } finally {
      error.mockRestore();
    }
  });

  it('keeps going after one symbol fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { io, saved } = fakeIO(
        [
          { id: 'i1', symbol: 'BAD' },
          { id: 'i2', symbol: 'AAPL' },
        ],
        async (symbol) => {
          if (symbol === 'BAD') throw new Error('nope');
          return { ok: true, profile: { ...emptyProfile, sector: 'Retail', sicCode: '5311' } };
        },
      );
      await syncInstrumentProfilesWith(io, ['i1', 'i2'], NOW);
      expect(saved.map((s) => s.id)).toEqual(['i2']);
    } finally {
      error.mockRestore();
    }
  });

  it('swallows a store failure without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const io: ProfileIO = {
        async listStale() {
          throw new Error('db down');
        },
        async fetchProfile() {
          throw new Error('should never be reached');
        },
        async save() {},
      };
      await expect(syncInstrumentProfilesWith(io, ['i1'], NOW)).resolves.toBeUndefined();
      expect(error.mock.calls[0][0]).toContain('db down');
    } finally {
      error.mockRestore();
    }
  });
});

/**
 * Bug audit 2026-08-18, major 4: the provider answered `null` for every
 * failure mode, so a timeout wrote a null over a KNOWN sector and stamped the
 * row fresh — the Industry breakdown migrated the holding into "Unknown" and
 * stayed wrong for the whole 30-day staleness window.
 */
describe('syncInstrumentProfiles — a transient failure destroys nothing', () => {
  it('writes nothing and stamps nothing when the vendor blips', async () => {
    const { io, saved, asked } = fakeIO([{ id: 'i1', symbol: 'AAPL' }], async () => ({
      ok: false,
      reason: 'error',
    }));
    await syncInstrumentProfilesWith(io, ['i1'], NOW);
    expect(asked).toEqual(['AAPL']);
    // No save at all: the row keeps its sector AND its old timestamp, so the
    // next visit retries instead of waiting out the staleness window.
    expect(saved).toEqual([]);
  });

  it('keeps syncing the other symbols when one blips', async () => {
    const { io, saved } = fakeIO(
      [
        { id: 'i1', symbol: 'FLAKY' },
        { id: 'i2', symbol: 'AAPL' },
      ],
      async (symbol) =>
        symbol === 'FLAKY'
          ? { ok: false, reason: 'error' }
          : { ok: true, profile: { ...emptyProfile, sector: 'Retail', sicCode: '5311' } },
    );
    await syncInstrumentProfilesWith(io, ['i1', 'i2'], NOW);
    expect(saved.map((row) => row.id)).toEqual(['i2']);
  });

  it('distinguishes a ticker the vendor does not carry from one it could not answer about', async () => {
    const { io, saved } = fakeIO(
      [
        { id: 'i1', symbol: 'GONE' },
        { id: 'i2', symbol: 'FLAKY' },
      ],
      async (symbol) =>
        symbol === 'GONE' ? { ok: false, reason: 'not_found' } : { ok: false, reason: 'error' },
    );
    await syncInstrumentProfilesWith(io, ['i1', 'i2'], NOW);
    // The 404 stamps (stop asking); the blip does not (ask again).
    expect(saved).toEqual([{ id: 'i1', profile: null, syncedAt: NOW }]);
  });

  it('an ok outcome writes all six classification columns', async () => {
    const profile: TickerProfile = {
      sector: 'Electronic Computers',
      sicCode: '3571',
      description: 'Apple designs consumer electronics.',
      totalEmployees: 164000,
      homepageUrl: 'https://www.apple.com',
      sharesOutstanding: '15101622000',
    };
    const { io, saved } = fakeIO([{ id: 'i1', symbol: 'AAPL' }], async () => ({
      ok: true,
      profile,
    }));
    await syncInstrumentProfilesWith(io, ['i1'], NOW);
    expect(saved[0]?.profile).toEqual(profile);
    expect(Object.keys(saved[0]!.profile!).sort()).toEqual([
      'description',
      'homepageUrl',
      'sector',
      'sharesOutstanding',
      'sicCode',
      'totalEmployees',
    ]);
  });

  it('a stamp-only outcome writes none of the classification columns', async () => {
    const { io, saved } = fakeIO([{ id: 'i1', symbol: 'GONE' }], async () => ({
      ok: false,
      reason: 'not_found',
    }));
    await syncInstrumentProfilesWith(io, ['i1'], NOW);
    expect(saved).toEqual([{ id: 'i1', profile: null, syncedAt: NOW }]);
  });
});
