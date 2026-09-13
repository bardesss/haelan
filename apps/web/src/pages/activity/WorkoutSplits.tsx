import { useTranslation } from '../../i18n/index.js'
import type { FilledSplit } from '@haelan/core/split-heart-rate'
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
  rows: readonly FilledSplit[]
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

  // A filled cell and a cell the watch sent are different claims about a kilometre - see
  // splitHeartRate.ts's own comment on FilledSplit. The dagger marks the weaker claim inline,
  // right on the number a reader would otherwise take as the watch's own; the footnote below the
  // table says once what it means, rather than repeating an explanation on every marked cell.
  const heartRateCell = (row: FilledSplit): string => {
    if (row.averageHeartRateBpm === null) return t('common.absent')
    const marker = row.averageHeartRateBpmSource === 'trace' ? '†' : ''
    return `${formatNumber(row.averageHeartRateBpm, 0, language, '')}${marker} ${t('activity.units.bpm')}`
  }
  const anyFilled = rows.some((row) => row.averageHeartRateBpmSource === 'trace')

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
              <td>{heartRateCell(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Only when THIS table filled a row - a table of provider values must not carry a note
       *  about a fill that did not happen. */}
      {anyFilled && <p className="workout-splits-footnote">{t('activity.workout.splits.filledFromTrace')}</p>}
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
export function WorkoutSplits({ autoSplits, laps }: {
  autoSplits: readonly FilledSplit[] | undefined
  laps: readonly FilledSplit[] | undefined
}) {
  const { t } = useTranslation()
  // Defaulted here, once, rather than trusted from the caller: workoutSummary.ts's splitsFrom
  // answers [] for an absent or non-array value on purpose ("an absent array reads the same as an
  // empty one"), and this component used to get that guarantee for free by reading
  // workoutDetail(...)'s own decode. Now that these arrive from the API response instead
  // (WorkoutDetail.tsx passes query.data.autoSplits/laps), the field can simply be missing - an
  // older cached response, a shape that predates this deploy, anything that never populated it -
  // and workoutSummary.ts's own opening line says why that must not throw here: this app has no
  // error boundary, so an unguarded `.length` on `undefined` would blank the entire workout page
  // rather than just leaving the splits card off it. Do not "simplify" this default away.
  const rows = autoSplits ?? []
  const lapRows = laps ?? []
  if (rows.length === 0 && lapRows.length === 0) return null
  return (
    <>
      {rows.length > 0 && (
        <SplitTable rows={rows} label={t('activity.workout.splits.autoLabel')} typed={false} />
      )}
      {lapRows.length > 0 && (
        <SplitTable rows={lapRows} label={t('activity.workout.splits.lapLabel')} typed />
      )}
    </>
  )
}
