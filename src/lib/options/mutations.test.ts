import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OCC_TICKER_RE,
  optionPositionAddSchema,
  optionPositionEditSchema,
} from '@/lib/validation';

/**
 * Unique write-path cases from the deleted options Server Actions, driven at
 * `src/lib/options/mutations.ts`. Schema shape (OCC ticker, lot-fields-only
 * edit) is unique to this surface and would otherwise die with the wrappers.
 * Screenshot parse stays in `src/lib/screenshots/parse.test.ts`.
 */

const h = vi.hoisted(() => ({
  insertValues: vi.fn(),
  deleteWhere: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        h.insertValues(values);
      }),
    })),
    delete: vi.fn(() => ({ where: h.deleteWhere })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        h.updateSet(values);
        return { where: h.updateWhere };
      }),
    })),
  },
  optionPositions: { userId: 'user_id', id: 'id' },
}));

import {
  deleteOptionPosition,
  editOptionPosition,
  insertOptionPosition,
} from '@/lib/options/mutations';

const LOT_ID = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';
const TICKER = 'O:AAPL260904C00220000';

function addInput(overrides: Record<string, string> = {}) {
  return {
    ticker: TICKER,
    underlying: 'AAPL',
    contractType: 'call',
    strikePrice: '220',
    expirationDate: '2026-09-04',
    sharesPerContract: '100',
    quantity: '2',
    entryPrice: '3.5',
    tradeDate: '2026-08-06',
    fees: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OCC ticker shape', () => {
  it('accepts the verified vendor ticker', () => {
    expect(OCC_TICKER_RE.test(TICKER)).toBe(true);
    expect(OCC_TICKER_RE.test('O:BRK.B261218P00450000')).toBe(true);
  });

  it('rejects garbage and injection shapes', () => {
    for (const bad of [
      'AAPL',
      'O:aapl260904C00220000', // lowercase root
      'O:AAPL260904X00220000', // not C/P
      'O:AAPL260904C0022000', // strike too short
      'O:AAPL260904C002200000', // strike too long
      'O:AAPL 260904C00220000', // whitespace
      'O:AAPL260904C00220000&x=1', // query tail
      'O:../AAPL260904C00220000', // path shape
      'javascript:alert(1)',
      '',
    ]) {
      expect(OCC_TICKER_RE.test(bad)).toBe(false);
    }
  });
});

describe('optionPositionAddSchema', () => {
  it('round-trips a valid add input', () => {
    const parsed = optionPositionAddSchema.parse(addInput());
    expect(parsed).toEqual({
      ticker: TICKER,
      underlying: 'AAPL',
      contractType: 'call',
      strikePrice: '220',
      expirationDate: '2026-09-04',
      sharesPerContract: '100',
      quantity: '2',
      entryPrice: '3.5',
      tradeDate: '2026-08-06',
      fees: '0',
    });
  });

  it('defaults empty fees to the string zero and normalizes a comma decimal', () => {
    expect(optionPositionAddSchema.parse(addInput()).fees).toBe('0');
    expect(optionPositionAddSchema.parse(addInput({ fees: '2,04' })).fees).toBe('2.04');
  });

  it('rejects negative fees', () => {
    expect(optionPositionAddSchema.safeParse(addInput({ fees: '-1' })).success).toBe(false);
  });

  it('rejects lowercase, whitespace and URL characters in the underlying', () => {
    for (const bad of ['aapl', 'AA PL', 'AAPL?x=1', '../AAPL', 'AAPL/../X', '']) {
      expect(optionPositionAddSchema.safeParse(addInput({ underlying: bad })).success).toBe(false);
    }
  });

  it('rejects a malformed ticker, zero/negative quantity, and impossible dates', () => {
    expect(optionPositionAddSchema.safeParse(addInput({ ticker: 'AAPL' })).success).toBe(false);
    expect(optionPositionAddSchema.safeParse(addInput({ quantity: '0' })).success).toBe(false);
    expect(optionPositionAddSchema.safeParse(addInput({ quantity: '-1' })).success).toBe(false);
    for (const bad of ['04-09-2026', '2026-02-31', 'not-a-date']) {
      expect(optionPositionAddSchema.safeParse(addInput({ expirationDate: bad })).success).toBe(
        false,
      );
      expect(optionPositionAddSchema.safeParse(addInput({ tradeDate: bad })).success).toBe(false);
    }
  });
});

describe('insertOptionPosition — the write', () => {
  it('inserts the row scoped to the caller user id', async () => {
    await insertOptionPosition('user-1', optionPositionAddSchema.parse(addInput()));
    expect(h.insertValues).toHaveBeenCalledWith({
      userId: 'user-1',
      ticker: TICKER,
      underlying: 'AAPL',
      contractType: 'call',
      strikePrice: '220',
      expirationDate: '2026-09-04',
      sharesPerContract: '100',
      quantity: '2',
      entryPrice: '3.5',
      tradeDate: '2026-08-06',
      fees: '0',
    });
  });
});

describe('deleteOptionPosition', () => {
  it('deletes scoped to the caller user', async () => {
    await deleteOptionPosition('user-1', LOT_ID);
    expect(h.deleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe('optionPositionEditSchema — lot fields only, strictly', () => {
  const editInput = (overrides: Record<string, string> = {}) => ({
    id: LOT_ID,
    quantity: '3',
    entryPrice: '18.35',
    tradeDate: '2026-08-06',
    fees: '1.96',
    ...overrides,
  });

  it('accepts a valid lot edit and defaults empty fees to zero', () => {
    expect(optionPositionEditSchema.parse(editInput())).toEqual({
      id: LOT_ID,
      quantity: '3',
      entryPrice: '18.35',
      tradeDate: '2026-08-06',
      fees: '1.96',
    });
    expect(optionPositionEditSchema.parse(editInput({ fees: '' })).fees).toBe('0');
  });

  it('REJECTS contract-identity fields — strict, not silently stripped', () => {
    const identityFields: Record<string, string>[] = [
      { ticker: TICKER },
      { underlying: 'AAPL' },
      { contractType: 'put' },
      { strikePrice: '380' },
      { expirationDate: '2026-12-18' },
      { sharesPerContract: '100' },
    ];
    for (const identity of identityFields) {
      expect(optionPositionEditSchema.safeParse(editInput(identity)).success).toBe(false);
    }
  });

  it('rejects a non-uuid id, zero/negative quantity and a malformed date', () => {
    expect(optionPositionEditSchema.safeParse(editInput({ id: 'not-a-uuid' })).success).toBe(false);
    expect(optionPositionEditSchema.safeParse(editInput({ quantity: '0' })).success).toBe(false);
    expect(optionPositionEditSchema.safeParse(editInput({ quantity: '-1' })).success).toBe(false);
    expect(
      optionPositionEditSchema.safeParse(editInput({ tradeDate: '2026-02-31' })).success,
    ).toBe(false);
    expect(
      optionPositionEditSchema.safeParse(editInput({ tradeDate: '14-08-2026' })).success,
    ).toBe(false);
  });
});

describe('editOptionPosition', () => {
  const editInput = {
    id: LOT_ID,
    quantity: '3',
    entryPrice: '18.35',
    tradeDate: '2026-08-06',
    fees: '1.96',
  };

  it('writes ONLY the lot fields, scoped to the caller user', async () => {
    await editOptionPosition('user-1', optionPositionEditSchema.parse(editInput));
    expect(h.updateSet).toHaveBeenCalledWith({
      quantity: '3',
      entryPrice: '18.35',
      tradeDate: '2026-08-06',
      fees: '1.96',
    });
    expect(h.updateWhere).toHaveBeenCalledTimes(1);
  });
});
