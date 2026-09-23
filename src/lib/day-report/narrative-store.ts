import 'server-only';

import { createHash } from 'node:crypto';

import { and, eq, lt } from 'drizzle-orm';

import type { DayReportNarrativeResponse, StoredDayFigure } from '@/lib/day-report/view-types';
import { db, dayReports } from '@/lib/db';

import type { DayReportFacts } from './facts';
import type { DayReportKind } from './kinds';
import { scopeKeyFor } from './kinds';
import { MODEL, narrativeEventSchema, writeNarrative, type NarrativeEvent } from './narrative';

const RESERVATION_LEASE_MS = 15 * 60_000;

interface NarrativeKey {
  userId: string;
  dayISO: string;
  portfolioId: string | null;
  scopeKey: string;
  kind: DayReportKind;
  fingerprint: string;
  /**
   * The headline the report showed, persisted beside the prose for the
   * history list. NOT part of the fingerprint — that hashes `facts` only, so
   * rows written before the figure columns existed stay non-stale.
   */
  figure: StoredDayFigure | null;
}

interface NarrativeReservation {
  createdAt: Date;
}

interface NarrativeValues {
  status: 'ready' | 'refused';
  portfolioNarrative: string | null;
  eventsNarrative: string | null;
  macroNarrative: string | null;
  events: NarrativeEvent[];
  todayLine: string | null;
  sources: Array<{ title: string; url: string }>;
}

export interface NarrativeStoreDependencies {
  buildFacts: typeof import('./view').buildFactsForNarrative;
  read: typeof readNarrative;
  reserve: (key: NarrativeKey) => Promise<NarrativeReservation | null>;
  generate: typeof writeNarrative;
  complete: (
    key: NarrativeKey,
    reservation: NarrativeReservation,
    values: NarrativeValues,
  ) => Promise<void>;
  release: (key: NarrativeKey, reservation: NarrativeReservation) => Promise<void>;
}

export function factsFingerprint(facts: DayReportFacts): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

export async function readNarrative(
  userId: string,
  dayISO: string,
  scopeKey: string,
  kind: DayReportKind,
  currentFingerprint: string,
): Promise<DayReportNarrativeResponse> {
  const [row] = await db
    .select()
    .from(dayReports)
    .where(
      and(
        eq(dayReports.userId, userId),
        eq(dayReports.day, dayISO),
        eq(dayReports.scopeKey, scopeKey),
        eq(dayReports.kind, kind),
      ),
    )
    .limit(1);
  if (!row) return emptyNarrative('pending');
  if (row.status === 'pending') return emptyNarrative('pending');
  if (row.status === 'refused') return emptyNarrative('refused');
  const sources = Array.isArray(row.sources)
    ? row.sources.filter(isNarrativeSource)
    : [];
  // Rows written before the writer returned events carry null; anything
  // malformed is dropped entry by entry, never trusted through.
  const events = Array.isArray(row.events)
    ? row.events.flatMap((entry) => {
        const parsed = narrativeEventSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    status: 'ready',
    portfolioNarrative: row.portfolioNarrative,
    eventsNarrative: row.eventsNarrative,
    macroNarrative: row.macroNarrative,
    events,
    todayLine: row.todayLine,
    sources,
    staleFigures: row.factsFingerprint !== currentFingerprint,
  };
}

export async function ensureDayReportNarrative(
  userId: string,
  dayISO: string,
  portfolioId: string | null,
  kind: DayReportKind,
  dependencies: NarrativeStoreDependencies = productionDependencies,
): Promise<DayReportNarrativeResponse> {
  const built = await dependencies.buildFacts(userId, dayISO, portfolioId, kind);
  if (built === null) return emptyNarrative('unavailable');
  const { facts, figure } = built;
  const fingerprint = factsFingerprint(facts);
  const scopeKey = scopeKeyFor(portfolioId);
  const key: NarrativeKey = { userId, dayISO, portfolioId, scopeKey, kind, fingerprint, figure };
  const reservation = await dependencies.reserve(key);
  if (reservation === null) {
    return dependencies.read(userId, dayISO, scopeKey, kind, fingerprint);
  }

  const written = await dependencies.generate(facts);
  if (!written.ok && written.reason !== 'refused') {
    await dependencies.release(key, reservation);
    return emptyNarrative(written.reason);
  }
  const values: NarrativeValues = written.ok
    ? {
        status: 'ready',
        portfolioNarrative: written.narrative.portfolioNarrative,
        eventsNarrative: written.narrative.eventsNarrative,
        macroNarrative: written.narrative.macroNarrative,
        events: written.narrative.events,
        todayLine: written.narrative.todayLine,
        sources: written.narrative.sources,
      }
    : {
        status: 'refused',
        portfolioNarrative: null,
        eventsNarrative: null,
        macroNarrative: null,
        events: [],
        todayLine: null,
        sources: [],
      };
  await dependencies.complete(key, reservation, values);
  return dependencies.read(userId, dayISO, scopeKey, kind, fingerprint);
}

async function reserveNarrative(key: NarrativeKey): Promise<NarrativeReservation | null> {
  // The lease is matched later by `createdAt` equality (complete/release), so
  // the value MUST round-trip exactly. Postgres `now()` carries microseconds
  // and a JS Date carries milliseconds — a `defaultNow()` reservation came
  // back truncated, never matched, and every narrative was written to zero
  // rows while the row stayed `pending` forever. Stamping our own Date keeps
  // both sides at millisecond precision.
  const now = new Date();
  const pending = {
    createdAt: now,
    userId: key.userId,
    day: key.dayISO,
    scopeKey: key.scopeKey,
    kind: key.kind,
    portfolioId: key.portfolioId,
    status: 'pending',
    portfolioNarrative: null,
    eventsNarrative: null,
    macroNarrative: null,
    events: [],
    todayLine: null,
    sources: [],
    factsFingerprint: key.fingerprint,
    model: MODEL,
    figureDay: key.figure?.figureDay ?? null,
    dayChangePln: key.figure?.dayChangePLN ?? null,
    dayChangePct: key.figure?.dayChangePct ?? null,
    figurePartial: key.figure?.partial ?? false,
  };
  const [inserted] = await db
    .insert(dayReports)
    .values(pending)
    .onConflictDoNothing()
    .returning({ createdAt: dayReports.createdAt });
  if (inserted) return inserted;

  const [reclaimed] = await db
    .update(dayReports)
    .set(pending)
    .where(
      and(
        ...keyPredicates(key),
        eq(dayReports.status, 'pending'),
        lt(dayReports.createdAt, new Date(now.getTime() - RESERVATION_LEASE_MS)),
      ),
    )
    .returning({ createdAt: dayReports.createdAt });
  return reclaimed ?? null;
}

async function completeNarrative(
  key: NarrativeKey,
  reservation: NarrativeReservation,
  values: NarrativeValues,
): Promise<void> {
  await db
    .update(dayReports)
    .set(values)
    .where(
      and(
        ...keyPredicates(key),
        eq(dayReports.status, 'pending'),
        eq(dayReports.createdAt, reservation.createdAt),
      ),
    );
}

async function releaseNarrative(
  key: NarrativeKey,
  reservation: NarrativeReservation,
): Promise<void> {
  await db
    .delete(dayReports)
    .where(
      and(
        ...keyPredicates(key),
        eq(dayReports.status, 'pending'),
        eq(dayReports.createdAt, reservation.createdAt),
      ),
    );
}

function keyPredicates(key: NarrativeKey) {
  return [
    eq(dayReports.userId, key.userId),
    eq(dayReports.day, key.dayISO),
    eq(dayReports.scopeKey, key.scopeKey),
    eq(dayReports.kind, key.kind),
  ] as const;
}

const productionDependencies: NarrativeStoreDependencies = {
  buildFacts: async (...args) => {
    const { buildFactsForNarrative } = await import('./view');
    return buildFactsForNarrative(...args);
  },
  read: readNarrative,
  reserve: reserveNarrative,
  generate: writeNarrative,
  complete: completeNarrative,
  release: releaseNarrative,
};

function emptyNarrative(status: DayReportNarrativeResponse['status']): DayReportNarrativeResponse {
  return {
    status,
    portfolioNarrative: null,
    eventsNarrative: null,
    macroNarrative: null,
    events: [],
    todayLine: null,
    sources: [],
    staleFigures: false,
  };
}

function isNarrativeSource(value: unknown): value is { title: string; url: string } {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.title === 'string' &&
    typeof source.url === 'string' &&
    source.url.startsWith('https://')
  );
}
