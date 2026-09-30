import { useCallback } from 'react'
import { useTranslation } from '../../../i18n/index.js'

// Every figure the sleep period read sends, by metric, to the words the night page already names it
// by (the terms table in PATTERNS.md), so a figure reads the same on both pages.
const LABEL_KEYS: Readonly<Record<string, string>> = {
  sleep_asleep_minutes: 'sleep.night.hero.label',
  sleep_efficiency: 'sleep.night.minis.efficiency',
  sleep_deep_minutes: 'sleep.night.minis.deep',
  sleep_rem_minutes: 'sleep.night.minis.rem',
  sleep_bedtime_minutes: 'sleep.night.minis.bedtime',
  sleep_waketime_minutes: 'sleep.night.more.waketime',
  sleep_bedtime_variability: 'sleep.period.variability',
  recovery_index: 'recoveryIndex.label',
  resting_heart_rate: 'sleep.night.morning.restingHeartRate',
  daily_hrv: 'sleep.night.morning.hrv',
  sleep_respiratory_rate: 'sleep.night.morning.breathing',
  daily_spo2: 'sleep.night.morning.spo2',
  sleep_temperature: 'sleep.night.morning.skinTemperature',
  sleep_light_minutes: 'sleep.night.more.light',
  sleep_awake_minutes: 'sleep.night.more.awake',
  sleep_in_bed_minutes: 'sleep.night.more.inBed',
  sleep_latency_minutes: 'sleep.night.more.minutesToFallAsleep',
  sleep_awakenings: 'sleep.night.more.awakenings',
  sleep_after_wake_minutes: 'sleep.night.more.minutesAfterWakeUp',
  sleep_nap_count: 'sleep.night.more.naps',
  sleep_nap_minutes: 'sleep.night.more.naps',
}

/** A figure's label, stable per language (PeriodFigureRows memoises on it); the metric id for one it does not know. */
export function useSleepLabel(): (metric: string) => string {
  const { t } = useTranslation()
  return useCallback((metric: string) => {
    const key = LABEL_KEYS[metric]
    return key === undefined ? metric : t(key)
  }, [t])
}
