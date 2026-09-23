import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unique cases from the deleted dividend Server Actions: withheld > gross,
 * portfolio-ownership and transacted-instrument gates, and the pass-through
 * of validated decimal strings into the store.
 */

const h = vi.hoisted(() => ({
  /** Plain select().from().where() — the portfolio ownership check. */
  selectWhere: vi.fn(),
  /** Joined select ... .limit() — the transacted-instrument check. */
  joinedLimit: vi.fn(),
  createManualPayment: vi.fn(),
  updatePayment: vi.fn(),
  deletePayment: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), asc: vi.fn(), eq: vi.fn() }));
vi.mock('@/lib/dividends/store', () => ({
  createManualPayment: h.createManualPayment,
  updatePayment: h.updatePayment,
  deletePayment: h.deletePayment,
}));
vi.mock('@/lib/dividends/sync', () => ({ syncDividends: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: h.selectWhere,
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: h.joinedLimit })),
          })),
        })),
      })),
    })),
  },
  portfolios: { id: 'id', userId: 'user_id' },
  instruments: { id: 'id' },
  transactions: { portfolioId: 'portfolio_id', instrumentId: 'instrument_id' },
}));

import {
  PORTFOLIO_LOCKED_MESSAGE,
  createDividendFor,
  deleteDividendFor,
  updateDividendFor,
} from '@/lib/dividends/mutations';
import {
  dividendCreateSchema,
  dividendUpdateSchema,
  type DividendCreateInput,
} from '@/lib/dividends/validation';

const PORTFOLIO_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const INSTRUMENT_ID = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';
const PAYMENT_ID = '7f1e0a54-3c1e-4d5f-9b2a-1c2d3e4f5a6b';

function paymentInput(overrides: Record<string, string> = {}): DividendCreateInput {
  return dividendCreateSchema.parse({
    instrumentId: INSTRUMENT_ID,
    portfolioId: PORTFOLIO_ID,
    exDate: '2026-08-10',
    payDate: '2026-08-13',
    quantity: '10',
    amountPerShare: '0.27',
    grossAmount: '2.7',
    withheldTax: '0.405',
    currency: 'USD',
    fxRateToBase: '3.65',
    note: '',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.selectWhere.mockResolvedValue([{ id: PORTFOLIO_ID }]);
  h.joinedLimit.mockResolvedValue([{ id: INSTRUMENT_ID }]);
  h.createManualPayment.mockResolvedValue(true);
});

describe('dividendCreateSchema — validation rejections', () => {
  it('rejects a negative gross amount', () => {
    const parsed = dividendCreateSchema.safeParse({
      instrumentId: INSTRUMENT_ID,
      portfolioId: PORTFOLIO_ID,
      exDate: '2026-08-10',
      quantity: '10',
      amountPerShare: '0.27',
      grossAmount: '-2.7',
      withheldTax: '0.405',
      currency: 'USD',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes('grossAmount'))).toBe(true);
    }
  });

  it('rejects withheld tax exceeding the gross amount', () => {
    const parsed = dividendCreateSchema.safeParse({
      instrumentId: INSTRUMENT_ID,
      portfolioId: PORTFOLIO_ID,
      exDate: '2026-08-10',
      quantity: '10',
      amountPerShare: '0.27',
      grossAmount: '2.7',
      withheldTax: '2.71',
      currency: 'USD',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("can't exceed the gross amount"))).toBe(
        true,
      );
    }
  });
});

describe('createDividendFor — ownership gates', () => {
  it('rejects a foreign portfolio without writing anything', async () => {
    h.selectWhere.mockResolvedValue([]);
    await expect(createDividendFor('user-1', paymentInput())).resolves.toEqual({
      ok: false,
      error: 'Portfolio not found.',
    });
    expect(h.createManualPayment).not.toHaveBeenCalled();
  });

  it('rejects an instrument the user never traded', async () => {
    h.joinedLimit.mockResolvedValue([]);
    await expect(createDividendFor('user-1', paymentInput())).resolves.toEqual({
      ok: false,
      error: 'Instrument not found.',
    });
    expect(h.createManualPayment).not.toHaveBeenCalled();
  });
});

describe('createDividendFor — the write', () => {
  it('passes validated decimal strings to the store', async () => {
    await createDividendFor('user-1', paymentInput({ note: 'broker statement' }));

    expect(h.createManualPayment).toHaveBeenCalledExactlyOnceWith('user-1', {
      portfolioId: PORTFOLIO_ID,
      instrumentId: INSTRUMENT_ID,
      exDate: '2026-08-10',
      payDate: '2026-08-13',
      quantity: '10',
      amountPerShare: '0.27',
      grossAmount: '2.7',
      withheldTax: '0.405',
      currency: 'USD',
      fxRateToBase: '3.65',
      note: 'broker statement',
    });
  });

  it('an empty FX field is stored as null — an honest absence, never a fake rate', async () => {
    const input = dividendCreateSchema.parse({
      instrumentId: INSTRUMENT_ID,
      portfolioId: PORTFOLIO_ID,
      exDate: '2026-08-10',
      payDate: '',
      quantity: '10',
      amountPerShare: '0.27',
      grossAmount: '2.7',
      withheldTax: '0.405',
      currency: 'USD',
      fxRateToBase: '',
      note: '',
    });
    await createDividendFor('user-1', input);
    expect(h.createManualPayment).toHaveBeenCalledExactlyOnceWith(
      'user-1',
      expect.objectContaining({ fxRateToBase: null, payDate: null }),
    );
  });

  it('accepts a comma decimal separator — the pl-PL mobile pad', async () => {
    const input = dividendCreateSchema.parse({
      instrumentId: INSTRUMENT_ID,
      portfolioId: PORTFOLIO_ID,
      exDate: '2026-08-10',
      payDate: '2026-08-13',
      quantity: '10',
      amountPerShare: '0,27',
      grossAmount: '2,7',
      withheldTax: '0,405',
      currency: 'USD',
      fxRateToBase: '3.65',
    });
    await createDividendFor('user-1', input);
    expect(h.createManualPayment).toHaveBeenCalledExactlyOnceWith(
      'user-1',
      expect.objectContaining({ amountPerShare: '0.27', grossAmount: '2.7', withheldTax: '0.405' }),
    );
  });
});

describe('updateDividendFor', () => {
  it('surfaces the vendor-row portfolio lock as a form error, not a throw', async () => {
    h.updatePayment.mockResolvedValue('portfolio_locked');

    const input = dividendUpdateSchema.parse({
      portfolioId: PORTFOLIO_ID,
      exDate: '2026-08-10',
      payDate: '2026-08-13',
      quantity: '10',
      amountPerShare: '0.27',
      grossAmount: '2.7',
      withheldTax: '0.405',
      currency: 'USD',
      fxRateToBase: '3.65',
    });
    const result = await updateDividendFor('user-1', PAYMENT_ID, input);

    expect(result).toEqual({ ok: false, error: PORTFOLIO_LOCKED_MESSAGE });
  });

  it('maps not_found to the payment-not-found error', async () => {
    h.updatePayment.mockResolvedValue('not_found');
    const input = dividendUpdateSchema.parse({
      portfolioId: PORTFOLIO_ID,
      exDate: '2026-08-10',
      quantity: '10',
      amountPerShare: '0.27',
      grossAmount: '2.7',
      withheldTax: '0.405',
      currency: 'USD',
    });
    await expect(updateDividendFor('user-1', PAYMENT_ID, input)).resolves.toEqual({
      ok: false,
      error: 'Payment not found.',
    });
  });
});

describe('deleteDividendFor', () => {
  it('reports "not found" when the ownership-scoped delete touched no row', async () => {
    h.deletePayment.mockResolvedValue(false);
    await expect(deleteDividendFor('user-1', PAYMENT_ID)).resolves.toEqual({
      ok: false,
      error: 'Payment not found.',
    });
  });
});
