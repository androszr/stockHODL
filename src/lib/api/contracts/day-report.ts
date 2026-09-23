import { z } from 'zod';

import { analyticsScopeSchema } from './analytics';
import {
  decimalStringSchema,
  directionSchema,
  displayStringSchema,
  epochMsSchema,
  isoDateSchema,
  uuidSchema,
} from './common';
import { chartPointSchema } from './series';

export const dayReportKindSchema = z
  .enum(['morning', 'close'])
  .meta({ title: 'DayReportPayloadKind' });

export const dayReportQuerySchema = z
  .object({
    day: isoDateSchema.optional(),
    kind: dayReportKindSchema.optional(),
    p: z.string().optional(),
  })
  .meta({ title: 'DayReportQuery' });

export const dayReportNarrativeRequestSchema = z
  .object({ day: isoDateSchema, kind: dayReportKindSchema, p: z.string().optional() })
  .meta({ title: 'DayReportNarrativeRequest' });

const signedDisplaySchema = z
  .object({ text: displayStringSchema, direction: directionSchema })
  .meta({ title: 'DayReportSignedDisplay' });

const dayReportFigurePartSchema = z
  .object({
    valueAtClose: displayStringSchema.nullable(),
    dayChange: signedDisplaySchema.nullable(),
    dayChangePct: displayStringSchema.nullable(),
  })
  .meta({ title: 'DayReportFigurePart' });

const dayReportFiguresSchema = z
  .object({
    status: z.enum(['ready', 'not_ready', 'empty']),
    source: z.enum(['live', 'stored']).nullable(),
    valueAtClose: displayStringSchema.nullable(),
    dayChange: signedDisplaySchema.nullable(),
    dayChangePct: displayStringSchema.nullable(),
    holdings: dayReportFigurePartSchema.nullable(),
    options: dayReportFigurePartSchema.nullable(),
    optionsDayChangeUSD: displayStringSchema.nullable(),
    optionsNote: z.string().nullable(),
    optionsRelation: z.enum(['amplified', 'cushioned', 'flat']).nullable(),
    partial: z.boolean(),
    partialSymbols: z.array(z.string()),
    excludedSymbols: z.array(z.string()),
    positionCount: z.number().int(),
  })
  .meta({ title: 'DayReportFigures' });

const dayReportRecapSchema = z
  .object({
    day: isoDateSchema,
    dayChange: signedDisplaySchema,
    dayChangePct: displayStringSchema.nullable(),
  })
  .meta({ title: 'DayReportRecap' });

const dayReportMoverSchema = z
  .object({
    symbol: z.string(),
    displayName: z.string(),
    contribution: signedDisplaySchema,
    pricePct: displayStringSchema.nullable(),
    barShare: decimalStringSchema,
  })
  .meta({ title: 'DayReportMover' });

const dayReportValueLineSchema = z
  .object({
    kind: z.enum(['intraday', 'daily', 'none']).meta({ title: 'DayReportValueLineKind' }),
    points: z.array(chartPointSchema),
    windowLabel: z.string().nullable(),
    partialDays: z.number().int(),
    excludedSymbols: z.array(z.string()),
  })
  .meta({ title: 'DayReportValueLine' });

const dayReportBenchmarkSchema = z
  .object({
    indexName: z.string(),
    proxySymbol: z.string(),
    dayPct: displayStringSchema.nullable(),
    direction: directionSchema,
    extendedPct: displayStringSchema.nullable(),
    extendedKind: z.enum(['early', 'late']).nullable(),
  })
  .meta({ title: 'DayReportBenchmark' });

const dayReportUsdPlnSchema = z
  .object({ rate: displayStringSchema, move: displayStringSchema, direction: directionSchema })
  .meta({ title: 'DayReportUsdPln' });

const dayReportHeadlineSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    publisherName: z.string().nullable(),
    publishedAtMs: epochMsSchema,
    matchedTickers: z.array(z.string()),
    sentiment: z.string().nullable(),
    /** Source material for the written report — the app never lists these. */
    url: z.string(),
    summary: z.string().nullable(),
  })
  .meta({ title: 'DayReportHeadline' });

const dayReportEventSchema = z
  .object({
    symbol: z.string(),
    kind: z.enum(['ex_dividend', 'option_expiry']).meta({ title: 'DayReportEventKind' }),
    date: isoDateSchema,
    detail: z.string(),
  })
  .meta({ title: 'DayReportEvent' });

const dayReportEventsSchema = z
  .object({ items: z.array(dayReportEventSchema), earningsCaption: z.string() })
  .meta({ title: 'DayReportEvents' });

const dayReportSourceSchema = z
  .object({ title: z.string(), url: z.url() })
  .meta({ title: 'DayReportSource' });

const dayReportNarrativeEventSchema = z
  .object({
    date: isoDateSchema,
    /** A held ticker, or null for a market-wide date (Fed, CPI, a summit). */
    symbol: z.string().nullable(),
    title: z.string(),
  })
  .meta({ title: 'DayReportNarrativeEvent' });

export const dayReportNarrativeSchema = z
  .object({
    status: z.enum(['ready', 'pending', 'refused', 'unavailable', 'not_configured']),
    portfolioNarrative: z.string().nullable(),
    eventsNarrative: z.string().nullable(),
    macroNarrative: z.string().nullable(),
    /**
     * The writer's dated list — the week ahead for a morning report, what
     * just happened for a close — which the Events card renders in place of
     * the market feed's own (option expiries, an ex-dividend). Empty until
     * the report is ready, and for rows written before the writer had it.
     */
    events: z.array(dayReportNarrativeEventSchema),
    /** One line for the push, or null when the writer gave none. */
    todayLine: z.string().nullable(),
    sources: z.array(dayReportSourceSchema),
    staleFigures: z.boolean(),
  })
  .meta({ title: 'DayReportNarrative' });

export const dayReportNarrativeResponseSchema = z
  .object({ narrative: dayReportNarrativeSchema })
  .meta({ title: 'DayReportNarrativeResponse' });

export const dayReportResponseSchema = z
  .object({
    status: z.enum(['ready', 'unavailable']),
    nearestDay: isoDateSchema.nullable(),
    day: isoDateSchema,
    dayLabel: z.string(),
    kind: dayReportKindSchema,
    prevDay: isoDateSchema.nullable(),
    nextDay: isoDateSchema.nullable(),
    isLatest: z.boolean(),
    segments: z
      .object({
        morning: z.enum(['ready', 'none']),
        close: z.enum(['ready', 'market_open', 'not_ready']),
      })
      .meta({ title: 'DayReportSegments' }),
    scopeId: uuidSchema.nullable(),
    scopes: z.array(analyticsScopeSchema),
    figures: dayReportFiguresSchema,
    recap: dayReportRecapSchema.nullable(),
    movers: z.array(dayReportMoverSchema),
    optionMovers: z.array(dayReportMoverSchema),
    valueLine: dayReportValueLineSchema,
    benchmarks: z.array(dayReportBenchmarkSchema),
    usdPln: dayReportUsdPlnSchema.nullable(),
    headlines: z.array(dayReportHeadlineSchema),
    events: dayReportEventsSchema,
    narrative: dayReportNarrativeSchema,
  })
  .meta({ title: 'DayReportResponse' });

export type DayReportResponse = z.output<typeof dayReportResponseSchema>;

/**
 * The Dashboard's day-report history: every report the server has WRITTEN
 * for the all-portfolios scope, newest first, paged by a keyset cursor
 * `YYYY-MM-DD:kind` naming the last row of the previous page. Every figure
 * is server-formatted display text taken from the columns persisted when the
 * report was written — the list never recomputes money, and a row written
 * before those columns existed carries nulls (rendered as a dash).
 */
export const dayReportHistoryQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}:(morning|close)$/)
      .optional(),
  })
  .meta({ title: 'DayReportHistoryQuery' });

export const dayReportHistoryItemSchema = z
  .object({
    day: isoDateSchema,
    kind: dayReportKindSchema,
    /** "Fri 19 Sep" — with the year appended when it differs from today's. */
    dayLabel: z.string(),
    /** The session the figure describes: `day` for a close report, the previous session for a morning brief. */
    figureDay: isoDateSchema.nullable(),
    figureDayLabel: z.string().nullable(),
    dayChange: signedDisplaySchema.nullable(),
    dayChangePct: displayStringSchema.nullable(),
    partial: z.boolean(),
    narrativeStatus: z.enum(['ready', 'refused']).meta({ title: 'DayReportHistoryNarrativeStatus' }),
  })
  .meta({ title: 'DayReportHistoryItem' });

export const dayReportHistoryResponseSchema = z
  .object({
    items: z.array(dayReportHistoryItemSchema),
    /** Pass back as `?cursor=` for the next (older) page; null when this was the last. */
    nextCursor: z.string().nullable(),
  })
  .meta({ title: 'DayReportHistoryResponse' });

export type DayReportHistoryItem = z.output<typeof dayReportHistoryItemSchema>;
export type DayReportHistoryResponse = z.output<typeof dayReportHistoryResponseSchema>;
