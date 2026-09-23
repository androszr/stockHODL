import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from './db-errors';

describe('isUniqueViolation', () => {
  it('matches a DrizzleQueryError-shaped wrapper with the code on its cause', () => {
    // drizzle-orm@0.45 wraps driver errors: the wrapper has query/params/cause
    // only, and the Postgres code sits on the cause. This is the shape a
    // duplicate portfolio name actually produces.
    const wrapper = Object.assign(new Error('Failed query'), {
      query: 'insert into "portfolios" ...',
      params: [],
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
    });
    expect(isUniqueViolation(wrapper)).toBe(true);
  });

  it('matches a bare driver error carrying the code directly', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('walks nested cause chains', () => {
    expect(isUniqueViolation({ cause: { cause: { code: '23505' } } })).toBe(true);
  });

  it('rejects other codes, empty chains and non-objects', () => {
    expect(isUniqueViolation({ code: '42P01' })).toBe(false);
    expect(isUniqueViolation({ cause: { code: '22008' } })).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('terminates on a circular cause chain', () => {
    const a: { code: string; cause?: unknown } = { code: '42P01' };
    a.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
