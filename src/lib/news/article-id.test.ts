import { describe, expect, it } from 'vitest';

import { isValidNewsArticleId } from './article-id';

describe('isValidNewsArticleId', () => {
  it('accepts an observed vendor hex id (64-char lowercase hex)', () => {
    expect(
      isValidNewsArticleId('c198cd1d6f404e667860bbac64107e6c090a6cb871e17a06dec1001e2fdff136'),
    ).toBe(true);
  });

  it('accepts the URL-safe alphabet within bounds', () => {
    expect(isValidNewsArticleId('Abc123_-xy')).toBe(true);
  });

  it('rejects path metacharacters', () => {
    expect(isValidNewsArticleId('../../etc/passwd')).toBe(false);
    expect(isValidNewsArticleId('abc/def/ghi')).toBe(false);
    expect(isValidNewsArticleId('abc?id=1&x=2')).toBe(false);
    expect(isValidNewsArticleId('abc%2e%2e1234')).toBe(false);
  });

  it('rejects the empty string and too-short ids', () => {
    expect(isValidNewsArticleId('')).toBe(false);
    expect(isValidNewsArticleId('abc1234')).toBe(false); // 7 < 8
  });

  it('rejects ids longer than 128 characters', () => {
    expect(isValidNewsArticleId('a'.repeat(128))).toBe(true);
    expect(isValidNewsArticleId('a'.repeat(129))).toBe(false);
  });
});
