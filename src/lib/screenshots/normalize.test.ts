import { describe, expect, it } from 'vitest';

import { decodeUploadedImage, sniffImageType } from './image-upload';
import {
  normalizeCurrency,
  normalizeDateToISO,
  normalizeMoneyString,
  normalizeTickerCandidate,
  tickerFromBrokerSymbol,
} from './normalize';

/**
 * The shared screenshot helpers, moved here from the options-only module when
 * the transaction import started using them. Every fixture is written the
 * way one of three reference broker screens prints it — the Saxo option screen
 * (`15-sty-2027`, `18,35`, `SNOW/15F27C240:xcbf`), the Saxo position screen
 * (`03-sie-2026`, `GOOGL:xnas`, `-2 964,60`) and the mBank transaction screen
 * (`02.09.2026`, `601,505`, `26 354,58`) — the layouts are real, the position
 * and transaction figures are invented.
 */

describe('sniffImageType — magic bytes, never the filename', () => {
  it('accepts a real PNG header', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniffImageType(png)).toBe('image/png');
  });

  it('accepts a real JPEG header', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
  });

  it('accepts a real WebP header (RIFF….WEBP)', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x2b, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  it('rejects a renamed PDF, an SVG and an empty buffer', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0]);
    const svg = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c, 0, 0, 0, 0]);
    expect(sniffImageType(pdf)).toBeNull();
    expect(sniffImageType(svg)).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('rejects a RIFF container that is not WebP (e.g. WAV)', () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x2b, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });
});

describe('decodeUploadedImage — the whole server-side upload gate', () => {
  const pngBase64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]).toString('base64');

  it('accepts a real PNG and reports the SNIFFED media type', () => {
    const decoded = decodeUploadedImage(pngBase64);
    expect(decoded?.mediaType).toBe('image/png');
    expect(decoded?.bytes.length).toBe(12);
  });

  it('rejects an empty payload, bad padding and a non-base64 alphabet', () => {
    expect(decodeUploadedImage('')).toBeNull();
    expect(decodeUploadedImage('iVBORw0KGgo')).toBeNull(); // length % 4 !== 0
    expect(decodeUploadedImage('iVBO$w0K')).toBeNull();
  });

  it('rejects a well-formed base64 payload that is not an image', () => {
    expect(decodeUploadedImage(Buffer.from('%PDF-1.4 hello').toString('base64'))).toBeNull();
  });
});

describe('normalizeDateToISO — the reference strings, in three formats', () => {
  it('reads the Saxo option expiry: 15-sty-2027 → 2027-01-15', () => {
    expect(normalizeDateToISO('15-sty-2027')).toBe('2027-01-15');
  });

  it('reads the Saxo position open date: 03-sie-2026 → 2026-08-03', () => {
    expect(normalizeDateToISO('03-sie-2026')).toBe('2026-08-03');
  });

  it('reads the mBank execution date DAY-FIRST: 02.09.2026 → 2026-09-02', () => {
    expect(normalizeDateToISO('02.09.2026')).toBe('2026-09-02');
    // The settlement date on the same screen, one day later — proof the two
    // are distinguishable and that nothing is month-first.
    expect(normalizeDateToISO('03.09.2026')).toBe('2026-09-03');
    expect(normalizeDateToISO('01-02-2026')).toBe('2026-02-01');
  });

  it('reads an English month: 18-Dec-2026 → 2026-12-18', () => {
    expect(normalizeDateToISO('18-Dec-2026')).toBe('2026-12-18');
  });

  it('passes a plain ISO date through', () => {
    expect(normalizeDateToISO('2026-12-18')).toBe('2026-12-18');
  });

  it('drops a clock time printed beside the date — the Saxo Opened cell', () => {
    // Verbatim off the Saxo position screen: "Opened 24-sie-2026 18:41:07" (figures invented).
    expect(normalizeDateToISO('24-sie-2026 18:41:07')).toBe('2026-08-24');
    expect(normalizeDateToISO('25-sie-2026 00:00')).toBe('2026-08-25');
    expect(normalizeDateToISO('2026-08-24 18:41:07')).toBe('2026-08-24');
    expect(normalizeDateToISO('2026-08-24T18:41:07')).toBe('2026-08-24');
    expect(normalizeDateToISO('02.09.2026 09:31')).toBe('2026-09-02');
    expect(normalizeDateToISO('24-sie-2026 6:41 PM')).toBe('2026-08-24');
  });

  it('rejects impossible and unrecognizable dates to null — never a guess', () => {
    expect(normalizeDateToISO('2026-02-31')).toBeNull();
    expect(normalizeDateToISO('31-lut-2026')).toBeNull();
    expect(normalizeDateToISO('31.02.2026')).toBeNull();
    expect(normalizeDateToISO('12.13.2026')).toBeNull(); // no 13th month
    expect(normalizeDateToISO('someday soon')).toBeNull();
    expect(normalizeDateToISO('18-xyz-2026')).toBeNull();
  });
});

describe('normalizeMoneyString — comma decimals and space grouping', () => {
  it('normalizes the Saxo option entry price: 18,35 → 18.35', () => {
    expect(normalizeMoneyString('18,35')).toBe('18.35');
  });

  it('normalizes the Saxo strike: 240,00 → 240.00', () => {
    expect(normalizeMoneyString('240,00')).toBe('240.00');
  });

  it('leaves the ambiguous comma-three-digits shape exactly as printed', () => {
    // `5,800` is either five point eight or five thousand eight hundred, and
    // the shared helper is not allowed to pick: it returns the string
    // untouched so `decimalString` rejects it downstream, loudly. This is what
    // keeps a grouped `5 800` option lot from silently becoming 5.8 shares.
    // The transaction import has screen-local evidence for the other reading
    // and does it in its own `normalizeScreenMoney`, tested next door.
    expect(normalizeMoneyString('5,800')).toBe('5,800');
    expect(normalizeMoneyString('601,505')).toBe('601,505');
  });

  it('strips grouping whitespace, including NBSP and narrow spaces', () => {
    expect(normalizeMoneyString('26 354,58')).toBe('26354.58');
    expect(normalizeMoneyString('26\u00a0354,58')).toBe('26354.58'); // NBSP
    expect(normalizeMoneyString('26\u202f354,58')).toBe('26354.58'); // narrow NBSP
    expect(normalizeMoneyString('1 234,50')).toBe('1234.50');
  });

  it('keeps a negative Saxo market value negative and passes dot decimals through', () => {
    expect(normalizeMoneyString('-2 964,60')).toBe('-2964.60');
    expect(normalizeMoneyString('2.04')).toBe('2.04');
  });

  it('returns null for an empty string', () => {
    expect(normalizeMoneyString('   ')).toBeNull();
  });
});

describe('ticker and currency candidates', () => {
  it('extracts SNOW from the Saxo option symbol SNOW/15F27C240:xcbf', () => {
    expect(tickerFromBrokerSymbol('SNOW/15F27C240:xcbf')).toBe('SNOW');
  });

  it('extracts GOOGL from the Saxo equity symbol GOOGL:xnas', () => {
    expect(tickerFromBrokerSymbol('GOOGL:xnas')).toBe('GOOGL');
  });

  it('uppercases a clean candidate and rejects garbage to null', () => {
    expect(normalizeTickerCandidate('net')).toBe('NET');
    expect(normalizeTickerCandidate('BRK.B')).toBe('BRK.B');
    expect(normalizeTickerCandidate('not a ticker')).toBeNull();
    expect(normalizeTickerCandidate('WAYTOOLONGSYMBOL')).toBeNull();
    expect(normalizeTickerCandidate('../NET')).toBeNull();
  });

  it('accepts an ISO-4217 code in any case and rejects anything else', () => {
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency(' pln ')).toBe('PLN');
    expect(normalizeCurrency('dollars')).toBeNull();
  });
});
