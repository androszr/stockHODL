import {
  lastCompletedSessionDateISO,
  nyDateISOAt,
  statusAt,
  type CalendarOverride,
} from '@/lib/market-data/market-clock';

export type FigureSource = 'live' | 'stored';

export function chooseFigureSource(input: {
  dayISO: string;
  nowMs: number;
  overrides: readonly CalendarOverride[];
}): FigureSource {
  const { dayISO, nowMs, overrides } = input;
  const phase = statusAt(nowMs, overrides);
  return nyDateISOAt(nowMs) === dayISO &&
    lastCompletedSessionDateISO(nowMs, overrides) === dayISO &&
    (phase === 'late_trading' || phase === 'closed')
    ? 'live'
    : 'stored';
}
