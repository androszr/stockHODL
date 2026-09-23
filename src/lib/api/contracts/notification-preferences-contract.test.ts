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

  it('refuses a non-boolean value', () => {
    expect(() =>
      notificationPreferencesSchema.parse({ priceAlerts: 'yes', dailySummary: false }),
    ).toThrow();
  });

  it('refuses a body missing a switch — a partial write is ambiguous', () => {
    expect(() => notificationPreferencesSchema.parse({ priceAlerts: true })).toThrow();
  });
});
