import { useCallback } from 'react'
import { useTranslation } from '../../i18n/index.js'

// Every figure the recovery period read sends, by metric, to the words the night page's morning
// already names it by (the terms table in PATTERNS.md), so a figure reads the same on both pages.
// Breathing rate is the index's own input name: the morning's "Breathing in sleep" is the night's
// reading, and the day's comes first here (the server's fallback reads the night's only without it).
const LABEL_KEYS: Readonly<Record<string, string>> = {
  recovery_index: 'recoveryIndex.label',
  resting_heart_rate: 'sleep.night.morning.restingHeartRate',
  daily_hrv: 'sleep.night.morning.hrv',
  respiratory_rate: 'recoveryIndex.input.respiratoryRate',
  sleep_respiratory_rate: 'sleep.night.morning.breathing',
}

/** A figure's label, stable per language (PeriodFigureRows memoises on it); the metric id for one it does not know. */
export function useRecoveryLabel(): (metric: string) => string {
  const { t } = useTranslation()
  return useCallback((metric: string) => {
    const key = LABEL_KEYS[metric]
    return key === undefined ? metric : t(key)
  }, [t])
}
