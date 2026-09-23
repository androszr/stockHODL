import 'server-only';

import { eq } from 'drizzle-orm';

import { db, instruments } from '@/lib/db';
import { lookupDirectorySymbol } from '@/lib/market-data/symbol-directory';

/**
 * The shared resolve-or-create path for the global `instruments` table — the
 * exact upsert + select + currency-mismatch sequence that used to live inline
 * in `createTransaction`, extracted (behavior byte-equivalent, messages
 * included) so every feature that mints an instrument — the transaction form
 * and the watchlist add — goes through ONE code path.
 */

export interface InstrumentFields {
  symbol: string;
  displayName: string;
  exchange: string;
  currency: string;
}

export type ResolveInstrumentResult =
  | { ok: true; id: string; currency: string }
  | { ok: false; error: string };

export async function resolveOrCreateInstrument(
  input: InstrumentFields,
): Promise<ResolveInstrumentResult> {
  // Instrument upsert keyed on the unique `symbol` column. Do-nothing (not
  // do-update) is load-bearing: a typo'd currency must never silently rewrite
  // an existing instrument and corrupt the fx semantics of every prior row.
  await db
    .insert(instruments)
    .values({
      symbol: input.symbol,
      displayName: input.displayName,
      exchange: input.exchange,
      currency: input.currency,
    })
    .onConflictDoNothing({ target: instruments.symbol });

  const [instrument] = await db
    .select({ id: instruments.id, currency: instruments.currency })
    .from(instruments)
    .where(eq(instruments.symbol, input.symbol));
  if (!instrument) return { ok: false, error: 'Could not save the instrument.' };

  if (instrument.currency !== input.currency) {
    return {
      ok: false,
      error: `${input.symbol} already exists as ${instrument.currency} — pick that currency or use a different symbol.`,
    };
  }

  return { ok: true, id: instrument.id, currency: instrument.currency };
}

/** Identity for a symbol nobody has a relationship with yet. */
export interface BrowsableInstrument {
  id: string;
  symbol: string;
  displayName: string;
  exchange: string;
  currency: string;
}

/**
 * Resolve a symbol for BROWSING — the fourth identity source, and the one
 * that needs no relationship to the user at all.
 *
 * The instrument screen used to answer only for a symbol the caller owned,
 * watched, or (on the web) held contracts on. Every other ticker was a 404:
 * you could not look at a stock before deciding to follow it, which is the
 * wrong way round — you look, and THEN you decide. Following it just to see
 * the price also polluted the watchlist with things nobody chose.
 *
 * Select-first, so the steady state does zero writes and a pre-existing row is
 * used exactly as it stands — `resolveOrCreateInstrument`'s currency-mismatch
 * refusal can never strand a screen that only wants to look. Only a genuinely
 * absent row consults the directory, and a symbol the directory has never
 * heard of stays `null`: the app is not an oracle over the vendor's universe,
 * and "we have never heard of this ticker" is a true and useful answer.
 *
 * The mint is what the durable quote cache and the price-history tables key
 * on, so it is not avoidable for a screen that charts anything. It follows the
 * web's options-underlying precedent verbatim, name and exchange clamped to
 * the watchlist action's own bounds: `instruments` is first-write-wins, so a
 * name minted at full vendor length would be permanent and would then make
 * every future "add to watchlist" for that symbol fail validation.
 */
export async function resolveInstrumentForBrowsing(
  symbol: string,
): Promise<BrowsableInstrument | null> {
  const [existing] = await db
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      exchange: instruments.exchange,
      currency: instruments.currency,
    })
    .from(instruments)
    .where(eq(instruments.symbol, symbol));
  if (existing) return existing;

  const directory = await lookupDirectorySymbol(symbol);
  if (directory === null) return null;

  const displayName = directory.name.slice(0, 80);
  const exchange = directory.exchange.slice(0, 20);
  // Every directory row is USD by definition of the source file — the US-only
  // decision, restated where it binds.
  const minted = await resolveOrCreateInstrument({
    symbol,
    displayName,
    exchange,
    currency: 'USD',
  });
  if (!minted.ok) {
    console.error(`Browsing mint failed (${symbol}): ${minted.error}`);
    return null;
  }

  return { id: minted.id, symbol, displayName, exchange, currency: minted.currency };
}
