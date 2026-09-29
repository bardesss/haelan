import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { GlanceBaseline, GlanceLog, GlanceNav, GlanceRecovery, GlanceStanding, GlanceStripDay } from './useGlance.js'
import type { Night } from './useNights.js'
import type { WorkoutSession } from './useSessions.js'

// Mirrors the wire shape of packages/core/src/query/nightPage.ts's NightPage, after
// apps/server/src/routes/v1/detail.ts rounds it and adds `log`, field for field rather than
// imported: @haelan/core's root export pulls in better-sqlite3 and drizzle, which have no business
// in a browser bundle (the same reason useGlance.ts, useNights.ts and useSessions.ts each carry
// their own copy of the payload they read rather than importing core's).
//
// `DayLog` is `GlanceLog` under another name: both mirror core's DayLog (packages/core/src/query/quickLog.ts)
// field for field, and useGlance.ts already carries that mirror as `GlanceLog` (its own optional
// field on `Glance`). Reused here rather than duplicated, so a change to the shape has one mirror
// to update, not two that could drift apart.
export type DayLog = GlanceLog

/**
 * The shape both detail pages read a figure in (packages/core/src/query/pageFigure.ts's PageFigure):
 * the value, its usual band, where it stands, and whether that is better or worse - all decided on
 * the server so this app never computes a verdict of its own (constraints.md's "the server judges;
 * the web renders").
 */
export interface PageFigure {
  metric: string
  value: number | null
  unit: string
  precision: number
  direction: 'up' | 'down' | 'neutral'
  baseline: GlanceBaseline | null
  standing: GlanceStanding | null
  judged: 'better' | 'worse' | null
  strip: GlanceStripDay[] | null
}

/** One intraday metric across one night (packages/core/src/query/nightTraces.ts's NightTrace). */
export interface NightTraceExtreme { value: number, atMs: number }
export interface NightTraceStat { lowest: NightTraceExtreme | null, highest: NightTraceExtreme | null, mean: number | null }
export interface NightTrace { metric: string, stat: NightTraceStat, lowestFigure: PageFigure, meanFigure: PageFigure }

/** The zero line a night's balance is signed against (packages/core/src/api/sleepBalance.ts's ZeroLine). */
export interface NightZeroLine { minutes: number, source: 'baseline' | 'target' }

export interface NightPageData {
  localDate: string
  sourceId: string
  night: Night
  nav: GlanceNav
  figures: {
    asleep: PageFigure, efficiency: PageFigure, deep: PageFigure, rem: PageFigure, light: PageFigure,
    awake: PageFigure, inBed: PageFigure, bedtime: PageFigure, waketime: PageFigure,
    napCount: PageFigure, napMinutes: PageFigure,
    minutesToFallAsleep: PageFigure, awakenings: PageFigure, minutesAfterWakeUp: PageFigure,
    bedtimeVariability: PageFigure
  }
  stagePercent: { deep: number | null, light: number | null, rem: number | null }
  balance: { zeroLine: NightZeroLine, nights: { localDate: string, difference: number | null }[], total: number }
  traces: { heartRate: NightTrace, hrv: NightTrace, spo2: NightTrace }
  morning: {
    recovery: GlanceRecovery
    restingHeartRate: PageFigure
    hrv: PageFigure
    breathing: PageFigure
    spo2: PageFigure
    skinTemperature: PageFigure
    skinTemperatureDeviation: number | null
  }
  day: { localDate: string, steps: PageFigure, activeMinutes: PageFigure, workouts: WorkoutSession[] }
  /** The quick log for the day this night belongs to (routes/v1/detail.ts: the day before `localDate`). */
  log: DayLog
}

/**
 * `queryKeys.resource(personId, 'night')` as the prefix, `localDate` appended, mirroring
 * `nightsPath`'s own comment on why this is exported: so the key shape can be asserted without
 * mounting a component.
 */
export function nightPageKey(personId: string, localDate: string): readonly unknown[] {
  return [...queryKeys.resource(personId, 'night'), localDate]
}

/**
 * One night's page: every figure on it judged against its own usual, the morning after it, the day
 * before it, and the day's quick log, all from one request (GET /p/:personId/night/:localDate).
 *
 * `localDate` is `undefined` before the route parameter it comes from has resolved, the same half
 * of the enabled guard `useNights` and `useSessions` already carry: without it an unresolved date
 * would fire `/night/undefined` the moment the person alone was ready.
 */
export function useNightPage(localDate: string | undefined): UseQueryResult<NightPageData> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: nightPageKey(personId ?? '', localDate ?? ''),
    enabled: personId !== undefined && localDate !== undefined,
    queryFn: () => apiGet<NightPageData>(`/api/v1/p/${personId!}/night/${encodeURIComponent(localDate!)}`),
  })
}
