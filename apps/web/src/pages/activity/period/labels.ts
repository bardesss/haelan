import { useCallback } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { formatDuration, formatNumber } from '../../../format.js'
import type { Translate } from '../../../format.js'

// Every figure the activity period read sends, by metric, to the words a page already names it by
// (the workout page's own terms where it has one), so a figure reads the same on both pages.
const LABEL_KEYS: Readonly<Record<string, string>> = {
  steps: 'activity.workout.page.day.steps',
  active_minutes: 'activity.workout.page.day.activeMinutes',
  distance: 'activity.distance.label',
  floors: 'activity.units.floorsShort',
  active_energy: 'activity.activeEnergy.label',
  total_calories: 'activity.totalCalories.label',
  active_zone_minutes: 'activity.activeZoneMinutes.label',
  workout_minutes: 'activity.period.workoutTime',
  altitude_gain: 'activity.workout.page.figures.elevationGain',
  sedentary_minutes: 'activity.period.sedentary',
  cardio_load_edwards: 'activity.workout.page.figures.cardioLoad',
}

// The averages a row's label says it is an average of, the approved mockup's "Actieve minuten, per
// week" and "Actieve energie, per dag"; a total (distance, floors, climb, workout time) says nothing.
const PER_WEEK: ReadonlySet<string> = new Set(['active_minutes'])
const PER_DAY: ReadonlySet<string> = new Set(['active_energy', 'total_calories', 'sedentary_minutes', 'cardio_load_edwards'])

/** A figure's plain name (the point panel's), stable per language; the metric id for one it does not know. */
export function useActivityName(): (metric: string) => string {
  const { t } = useTranslation()
  return useCallback((metric: string) => {
    const key = LABEL_KEYS[metric]
    return key === undefined ? metric : t(key)
  }, [t])
}

/** A row's label: the name, and for an average what it is an average of. Stable per language (PeriodFigureRows memoises on it). */
export function useActivityLabel(): (metric: string) => string {
  const { t } = useTranslation()
  const name = useActivityName()
  return useCallback((metric: string) => {
    const label = name(metric)
    if (PER_WEEK.has(metric)) return t('activity.period.perWeek', { label })
    if (PER_DAY.has(metric)) return t('activity.period.perDay', { label })
    return label
  }, [name, t])
}

// A value never wraps inside itself (PATTERNS.md's Values).
const NBSP = ' '

/**
 * A span of minutes as the approved mockup prints one: "24 min" under an hour, "7h 00m" from an
 * hour on (the zones' legend, a type's time).
 */
export function minutesText(minutes: number, language: string, t: Translate): string {
  const rounded = Math.round(minutes)
  return rounded < 60
    ? `${formatNumber(rounded, 0, language, t('common.absent'))}${NBSP}${t('activity.units.min')}`
    : formatDuration(rounded, language).replaceAll(' ', NBSP)
}

/** A count of minutes, whatever its size ("6,240 min"): a legend's period total of a band. */
export function minutesCount(minutes: number | null, language: string, t: Translate): string {
  return `${formatNumber(minutes, 0, language, t('common.absent'))}${NBSP}${t('activity.units.min')}`
}
