import { describe, expect, it } from 'vitest';

import { notificationPreferencesSchema } from './notification-preferences';

describe('notificationPreferencesSchema', () => {
  it('round-trips the two switches', () => {
    const parsed = notificationPreferencesSchema.parse({
      priceAlerts: true,
      dailySummary: false,
    });
    expect(parsed).toEqual({ priceAlerts: true, dailySummary: false });
  });

  it('carries the Daily reports switch when it is sent', () => {
    const parsed = notificationPreferencesSchema.parse({
      priceAlerts: false,
      dailySummary: true,
      dayReports: true,
    });
    expect(parsed).toEqual({ priceAlerts: false, dailySummary: true, dayReports: true });
  });

  it('accepts a body from a build older than the Daily reports switch, leaving it absent', () => {
    const parsed = notificationPreferencesSchema.parse({ priceAlerts: true, dailySummary: true });
    expect('dayReports' in parsed).toBe(false);
  });

  it('refuses a non-boolean Daily reports value', () => {
    expect(() =>
      notificationPreferencesSchema.parse({
        priceAlerts: true,
        dailySummary: true,
        dayReports: 'paused',
      }),
    ).toThrow();
  });

  it('refuses a non-boolean value', () => {
    expect(() =>
      notificationPreferencesSchema.parse({ priceAlerts: 'yes', dailySummary: false }),
    ).toThrow();
  });

  it('refuses a body missing a switch — a partial write is ambiguous', () => {
    expect(() => notificationPreferencesSchema.parse({ priceAlerts: true })).toThrow();
  });
});
