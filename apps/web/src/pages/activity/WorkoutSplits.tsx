import { useTranslation } from '../../i18n/index.js'
import type { WorkoutDetail, WorkoutSplit } from '@haelan/core/workout-summary'
import { Card } from '../../components/Card.js'
import { formatNumber } from '../../format.js'
import { formatPace } from './pace.js'

/**
 * Two tables at most, never one merged table.
 *
 * `autoSplits` is the provider's automatic split (its own default is 1 km or 1 mile); `laps` is a
 * recorded lap. They are never merged: a manual lap and an automatic kilometre are different claims
 * about the same run. Measured 2026-09-11: splits on 37 of 197 sessions, laps on ZERO - every
 * splitType in the whole archive is DISTANCE and no MANUAL lap exists anywhere. So the absent state
 * below is the common case, and the lap table is mapped for the schema rather than on evidence,
 * against a future device that records one.
 */
function SplitTable({ rows, label, typed }: {
  rows: readonly WorkoutSplit[]
  label: string
  // Only the laps table is ever labelled by its own type - see WorkoutSplits below for why.
  typed: boolean
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // Every cell tested with !== null, never truthiness: a split that covered a recorded zero metres
  // is a different statement from one that recorded no distance at all, and the absent marker below
  // says the second without claiming the first.
  const cell = (value: number | null, render: (value: number) => string): string =>
    value === null ? t('common.absent') : render(value)

  const splitType = rows[0]?.splitType ?? null
  const cardLabel = typed && splitType !== null
    ? t('activity.workout.splits.lapLabelTyped', {
      type: t(`activity.workout.splits.type.${splitType}`, { defaultValue: splitType }),
    })
    : label

  return (
    <Card span={12} label={cardLabel}>
      <table className="workout-splits">
        <thead>
          <tr>
            <th scope="col">{t('activity.workout.splits.number')}</th>
            <th scope="col">{t('activity.workout.splits.distance')}</th>
            <th scope="col">{t('activity.workout.splits.duration')}</th>
            <th scope="col">{t('activity.workout.splits.pace')}</th>
            <th scope="col">{t('activity.workout.splits.heartRate')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.startMs ?? 'unknown'}-${index}`}>
              <td>{formatNumber(index + 1, 0, language, '')}</td>
              <td>{cell(row.distanceMeters, (v) => `${formatNumber(v / 1000, 2, language, '')} ${t('activity.units.km')}`)}</td>
              <td>{cell(row.activeDurationSeconds, (v) => `${formatNumber(Math.round(v / 60), 0, language, '')} ${t('activity.units.min')}`)}</td>
              <td>{cell(row.paceSecondsPerKm, (v) => `${formatPace(v, language)} ${t('activity.units.paceSuffix')}`)}</td>
              <td>{cell(row.averageHeartRateBpm, (v) => `${formatNumber(v, 0, language, '')} ${t('activity.units.bpm')}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

/**
 * autoSplits and laps, each in a card of its own when the session carries it, absent entirely when
 * it carries neither - four workouts in five, measured 2026-09-11. Named for what each table IS,
 * not for a generic "splits" concept the two could be confused under: an automatic split's label
 * never varies (the provider always writes the same kind), while a lap's does - splitType is the
 * one thing distinguishing "the person pressed lap" from a future device's other lap kinds - which
 * is why only the laps table is ever labelled by its own type.
 */
export function WorkoutSplits({ detail }: { detail: WorkoutDetail }) {
  const { t } = useTranslation()
  if (detail.autoSplits.length === 0 && detail.laps.length === 0) return null
  return (
    <>
      {detail.autoSplits.length > 0 && (
        <SplitTable rows={detail.autoSplits} label={t('activity.workout.splits.autoLabel')} typed={false} />
      )}
      {detail.laps.length > 0 && (
        <SplitTable rows={detail.laps} label={t('activity.workout.splits.lapLabel')} typed />
      )}
    </>
  )
}
