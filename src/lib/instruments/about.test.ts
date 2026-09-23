import { describe, expect, it } from 'vitest';

import { composeAbout, week52Window, type AboutBar, type AboutProfile } from './about';

const EMPTY_PROFILE: AboutProfile = {
  description: null,
  totalEmployees: null,
  homepageUrl: null,
  sharesOutstanding: null,
};

function bars(entries: [string, AboutBar][]): Map<string, AboutBar> {
  return new Map(entries);
}

describe('week52Window', () => {
  it('is an inclusive 364-day span ending on today', () => {
    expect(week52Window('2026-09-05')).toEqual({ from: '2025-09-06', to: '2026-09-05' });
  });
});

describe('composeAbout', () => {
  it('uses high and low when present', () => {
    const about = composeAbout(
      EMPTY_PROFILE,
      { price: '200', currency: 'USD' },
      'USD',
      bars([
        ['2026-01-01', { close: '150', high: '160', low: '140' }],
        ['2026-06-01', { close: '210', high: '220', low: '190' }],
      ]),
    );
    expect(about.week52?.lowRaw).toBe('140');
    expect(about.week52?.highRaw).toBe('220');
    expect(about.week52?.currentRaw).toBe('200');
    expect(about.week52?.low).toContain('140');
    expect(about.week52?.high).toContain('220');
  });

  it('falls back to close when high and low are null', () => {
    const about = composeAbout(
      EMPTY_PROFILE,
      { price: '12', currency: 'USD' },
      'USD',
      bars([
        ['2026-01-01', { close: '10', high: null, low: null }],
        ['2026-06-01', { close: '30', high: null, low: null }],
      ]),
    );
    expect(about.week52?.lowRaw).toBe('10');
    expect(about.week52?.highRaw).toBe('30');
  });

  it('returns week52 null for an empty bars map', () => {
    const about = composeAbout(EMPTY_PROFILE, { price: '10', currency: 'USD' }, 'USD', new Map());
    expect(about.week52).toBeNull();
  });

  it('dashes market cap and currentRaw on a currency-mismatched quote, keeping the range', () => {
    const about = composeAbout(
      { ...EMPTY_PROFILE, sharesOutstanding: '1000' },
      { price: '200', currency: 'PLN' },
      'USD',
      bars([['2026-01-01', { close: '10', high: '12', low: '8' }]]),
    );
    expect(about.marketCap).toBeNull();
    expect(about.week52?.currentRaw).toBeNull();
    expect(about.week52?.lowRaw).toBe('8');
    expect(about.week52?.highRaw).toBe('12');
  });

  it('groups employees pl-PL', () => {
    const about = composeAbout(
      { ...EMPTY_PROFILE, totalEmployees: 125_000 },
      undefined,
      'USD',
      new Map(),
    );
    expect(about.employees).toBe('125\u00a0000');
  });

  it('leaves every field null when the profile is empty and there are no bars', () => {
    expect(composeAbout(EMPTY_PROFILE, undefined, 'USD', new Map())).toEqual({
      description: null,
      marketCap: null,
      employees: null,
      website: null,
      week52: null,
    });
  });

  it('formats market cap from shares times the currency-matching price', () => {
    const about = composeAbout(
      { ...EMPTY_PROFILE, sharesOutstanding: '15100000000' },
      { price: '226.00', currency: 'USD' },
      'USD',
      new Map(),
    );
    expect(about.marketCap).toBe('3,41T');
  });

  it('passes description and website through', () => {
    const about = composeAbout(
      {
        description: 'Apple designs and manufactures consumer electronics.',
        totalEmployees: null,
        homepageUrl: 'https://www.apple.com',
        sharesOutstanding: null,
      },
      undefined,
      'USD',
      new Map(),
    );
    expect(about.description).toContain('Apple designs');
    expect(about.website).toBe('https://www.apple.com');
  });
});
