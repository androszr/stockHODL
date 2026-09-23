import { describe, expect, it } from 'vitest';

import { alertDisplayName } from './alert-title';

describe('alertDisplayName — the push headline name', () => {
  it('passes a short name through unchanged', () => {
    expect(alertDisplayName('Apple Inc.', 'AAPL')).toBe('Apple Inc.');
  });

  it('drops the Nasdaq share-class tail', () => {
    expect(alertDisplayName('Apple Inc. - Common Stock', 'AAPL')).toBe('Apple Inc.');
    expect(alertDisplayName('Alphabet Inc. - Class A Common Stock', 'GOOGL')).toBe('Alphabet Inc.');
  });

  it('truncates a long name on a word boundary', () => {
    expect(alertDisplayName('International Business Machines', 'IBM')).toBe('International…');
  });

  it('falls back to the ticker when the name is empty or dash-only', () => {
    expect(alertDisplayName('', 'AAPL')).toBe('AAPL');
    expect(alertDisplayName('   ', 'AAPL')).toBe('AAPL');
    expect(alertDisplayName(' - Common Stock', 'AAPL')).toBe('AAPL');
  });

  it('falls back to the ticker when the first word alone overflows the budget', () => {
    expect(alertDisplayName('Supercalifragilisticexpialidocious', 'SUPR')).toBe('SUPR');
  });

  it('never exceeds the title budget', () => {
    const long = 'Taiwan Semiconductor Manufacturing Company Limited';
    expect(alertDisplayName(long, 'TSM').length).toBeLessThanOrEqual(23);
  });
});
