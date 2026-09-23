import type { PushAlert } from './apns';
import { dayReportUrlScheme } from './daily-summary';

export interface MorningBriefInput {
  recap: { dayChange: { text: string }; dayChangePct: string | null } | null;
  /**
   * The writer's one-liner for today ("Fed minutes Wed 14:00 · NKE earnings
   * Thu after close"), or null when the report is not ready. Headline and
   * event COUNTS were dropped on purpose (2026-09-21): the report never
   * shows headlines, and "0 events today" was noise.
   */
  todayLine: string | null;
  dayISO: string;
}

export function composeMorningBriefAlert(input: MorningBriefInput): PushAlert | null {
  const today = input.todayLine?.trim() ?? '';
  if (input.recap === null && today === '') return null;
  const lines: string[] = [];
  if (input.recap) {
    const pct = input.recap.dayChangePct === null ? '' : ` (${input.recap.dayChangePct})`;
    lines.push(`Yesterday: ${input.recap.dayChange.text}${pct}`);
  }
  if (today !== '') lines.push(today);
  return {
    title: 'Before the open',
    body: lines.join('\n'),
    urlScheme: dayReportUrlScheme(input.dayISO, 'morning'),
  };
}
