import { describe, expect, it } from 'vitest';

import { chooseFigureSource } from './source';

describe('chooseFigureSource', () => {
  it('uses live after the close on D', () => expect(chooseFigureSource({ dayISO: '2026-09-04', nowMs: Date.UTC(2026, 8, 4, 21, 15), overrides: [] })).toBe('live'));
  it('uses stored the next morning', () => expect(chooseFigureSource({ dayISO: '2026-09-04', nowMs: Date.UTC(2026, 8, 5, 12), overrides: [] })).toBe('stored'));
  it('uses stored while D is open', () => expect(chooseFigureSource({ dayISO: '2026-09-04', nowMs: Date.UTC(2026, 8, 4, 16), overrides: [] })).toBe('stored'));
  it('uses stored for Friday on Saturday', () => expect(chooseFigureSource({ dayISO: '2026-09-04', nowMs: Date.UTC(2026, 8, 5, 21), overrides: [] })).toBe('stored'));
});
