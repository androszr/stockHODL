import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DayReportFacts } from './facts';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: () => ({ ANTHROPIC_API_KEY: undefined }) }));

import { leaksInternals, searchBudgetFor, writeNarrative } from './narrative';

const facts = { kind: 'close', day: '2026-09-04' } as DayReportFacts;
const morningFacts = { kind: 'morning', day: '2026-09-04' } as DayReportFacts;
const prose = {
  portfolioNarrative: 'Portfolio.', eventsNarrative: 'Events.', macroNarrative: 'Macro.',
  events: [{ date: '2026-09-04', symbol: 'NKE', title: 'Earnings, after the close' }],
  todayLine: 'NKE earnings after close',
  sources: [{ title: 'Source', url: 'https://example.com/story' }],
};

function client(...responses: Array<Record<string, unknown>>) {
  const parse = vi.fn();
  for (const response of responses) parse.mockResolvedValueOnce({ content: [], ...response });
  return { sdk: { messages: { parse } } as unknown as Anthropic, parse };
}

describe('writeNarrative', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns not_configured without constructing a call', async () => expect(await writeNarrative(facts)).toEqual({ ok: false, reason: 'not_configured' }));
  it('maps refusal', async () => expect(await writeNarrative(facts, { client: client({ stop_reason: 'refusal', parsed_output: null }).sdk })).toEqual({ ok: false, reason: 'refused' }));
  it('maps max_tokens', async () => expect(await writeNarrative(facts, { client: client({ stop_reason: 'max_tokens', parsed_output: null }).sdk })).toEqual({ ok: false, reason: 'unavailable' }));
  it('maps a null parsed output', async () => expect(await writeNarrative(facts, { client: client({ stop_reason: 'end_turn', parsed_output: null }).sdk })).toEqual({ ok: false, reason: 'unavailable' }));
  it('returns structured prose', async () => expect((await writeNarrative(facts, { client: client({ stop_reason: 'end_turn', parsed_output: prose }).sdk })).ok).toBe(true));
  it('drops non-https sources', async () => {
    const dirty = { ...prose, sources: [{ title: 'Bad', url: 'http://example.com' }, prose.sources[0]] };
    const result = await writeNarrative(facts, { client: client({ stop_reason: 'end_turn', parsed_output: dirty }).sdk });
    expect(result.ok && result.narrative.sources).toEqual(prose.sources);
  });
  it('continues pause_turn up to four times, then gives up', async () => {
    const pause = { stop_reason: 'pause_turn', parsed_output: null };
    const fake = client(pause, pause, pause, pause, { stop_reason: 'end_turn', parsed_output: prose });
    expect((await writeNarrative(facts, { client: fake.sdk })).ok).toBe(true);
    expect(fake.parse).toHaveBeenCalledTimes(5);
    const exhausted = client(pause, pause, pause, pause, pause, { stop_reason: 'end_turn', parsed_output: prose });
    expect(await writeNarrative(facts, { client: exhausted.sdk })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('budgets a morning report more searches than a close', async () => {
    expect(searchBudgetFor('morning')).toBe(8);
    expect(searchBudgetFor('close')).toBe(5);
    const fake = client({ stop_reason: 'end_turn', parsed_output: prose });
    await writeNarrative(morningFacts, { client: fake.sdk });
    expect(fake.parse.mock.calls[0][0].tools[0]).toMatchObject({ type: 'web_search_20260209', max_uses: 8 });
    expect(fake.parse.mock.calls[0][0].tools[1]).toMatchObject({ type: 'web_fetch_20260209', max_uses: 8 });
    expect(fake.parse.mock.calls[0][0].output_config).toMatchObject({ effort: 'medium' });
    expect(fake.parse.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(4096);
    expect(fake.parse.mock.calls[0][0].system).toMatch(/never list or quote headlines/i);
    expect(fake.parse.mock.calls[0][0].system).toMatch(/never mention what you were or were not given/i);
  });
  it('retries once when the prose talks about its inputs, then accepts the rewrite', async () => {
    const leaky = { ...prose, eventsNarrative: 'No scheduled events were supplied, and earnings dates come from the macro search.' };
    const fake = client({ stop_reason: 'end_turn', parsed_output: leaky }, { stop_reason: 'end_turn', parsed_output: prose });
    const result = await writeNarrative(facts, { client: fake.sdk });
    expect(result.ok && result.narrative.eventsNarrative).toBe('Events.');
    expect(fake.parse).toHaveBeenCalledTimes(2);
    expect(fake.parse.mock.calls[1][0].messages.at(-1)).toMatchObject({ role: 'user' });
    expect(fake.parse.mock.calls[1][0].messages.at(-1).content).toMatch(/refers to its own inputs/);
  });
  it('accepts a second leaky answer rather than looping forever', async () => {
    const leaky = { ...prose, macroNarrative: 'The market feed had nothing.' };
    const fake = client({ stop_reason: 'end_turn', parsed_output: leaky }, { stop_reason: 'end_turn', parsed_output: leaky });
    expect((await writeNarrative(facts, { client: fake.sdk })).ok).toBe(true);
    expect(fake.parse).toHaveBeenCalledTimes(2);
  });
});

describe('leaksInternals', () => {
  const clean = { portfolioNarrative: 'Nike fell 2,34% after a weak quarter.', eventsNarrative: 'Nike reports Thursday after the close.', macroNarrative: 'The Fed meets Wednesday.' };
  it('passes ordinary prose', () => expect(leaksInternals(clean)).toBe(false));
  it.each([
    'No scheduled events were supplied.',
    'Earnings dates come from the macro search rather than the market feed.',
    'The headlines were mixed.',
    'I was not given any events.',
  ])('flags %s', (text) => expect(leaksInternals({ ...clean, eventsNarrative: text })).toBe(true));
  it('does not flag "search" as an ordinary verb', () =>
    expect(leaksInternals({ ...clean, macroNarrative: 'Investors search for direction ahead of the Fed.' })).toBe(false));
});
