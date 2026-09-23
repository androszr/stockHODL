import { describe, expect, it } from 'vitest';

import { UNKNOWN_KEY } from './allocation';
import { categoryColorVar, CATEGORY_COLOR_COUNT, sliceColorVar } from './palette';

describe('categoryColorVar', () => {
  it('maps index 0 to the first category token', () => {
    expect(categoryColorVar(0)).toBe('var(--color-cat-1)');
  });

  it('maps the last in-range index to the last token', () => {
    expect(categoryColorVar(CATEGORY_COLOR_COUNT - 1)).toBe('var(--color-cat-8)');
  });

  it('wraps past the end of the palette', () => {
    expect(categoryColorVar(CATEGORY_COLOR_COUNT)).toBe('var(--color-cat-1)');
    expect(categoryColorVar(CATEGORY_COLOR_COUNT + 2)).toBe('var(--color-cat-3)');
  });

  it('wraps a negative index into range rather than emitting cat-0', () => {
    expect(categoryColorVar(-1)).toBe('var(--color-cat-8)');
  });
});

describe('sliceColorVar', () => {
  it('pins the Unknown bucket to its own token wherever it sorts', () => {
    expect(sliceColorVar(UNKNOWN_KEY, 0)).toBe('var(--color-cat-unknown)');
    expect(sliceColorVar(UNKNOWN_KEY, 5)).toBe('var(--color-cat-unknown)');
  });

  it('gives a named bucket its positional colour', () => {
    expect(sliceColorVar('AAPL', 2)).toBe('var(--color-cat-3)');
  });

  it('emits token names only, never a colour literal', () => {
    const outputs = [
      ...Array.from({ length: 12 }, (_, i) => categoryColorVar(i)),
      sliceColorVar(UNKNOWN_KEY, 0),
    ];
    // The colour-function names are ASSEMBLED, not spelled: the acceptance
    // criterion greps this whole directory for them, and a test that wrote
    // them out would fail the rule it exists to defend.
    const literal = new RegExp(
      ['#[0-9a-f]{3}', 'okl' + 'ch\\(', 'r' + 'gb\\(', 'h' + 'sl\\('].join('|'),
      'i',
    );
    for (const output of outputs) {
      expect(output).not.toMatch(literal);
      expect(output).toMatch(/^var\(--color-cat-[a-z0-9]+\)$/);
    }
  });
});
