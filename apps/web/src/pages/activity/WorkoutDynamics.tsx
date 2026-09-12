import { useTranslation } from '../../i18n/index.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { formatNumber } from '../../format.js'

interface Tile { key: string, value: string, unit: string }

/**
 * The schema states these appear only in advanced running exercises, and 35 of 197 measured
 * sessions carry them: this card is absent on most sessions by design rather than by failure.
 */
export function WorkoutDynamics({ detail }: { detail: WorkoutDetail }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const mobility = detail.mobility
  if (mobility === null) return null

  const n = (value: number, precision: number) => formatNumber(value, precision, language, '')
  // Each tile only when the device actually recorded that one field - mobility is not null-if-any
  // was recorded (mobilityFrom's own rule), which does not mean every one of its five members is.
  const tiles: Tile[] = [
    mobility.cadenceStepsPerMinute === null ? null
      : { key: 'cadence', value: n(mobility.cadenceStepsPerMinute, 0), unit: t('activity.units.spm') },
    mobility.strideLengthMeters === null ? null
      : { key: 'stride', value: n(mobility.strideLengthMeters, 2), unit: t('activity.units.meters') },
    mobility.groundContactTimeSeconds === null ? null
      : { key: 'groundContact', value: n(mobility.groundContactTimeSeconds * 1000, 0), unit: t('activity.units.ms') },
    mobility.verticalOscillationMeters === null ? null
      : { key: 'oscillation', value: n(mobility.verticalOscillationMeters * 100, 1), unit: t('activity.units.cm') },
    mobility.verticalRatio === null ? null
      : { key: 'verticalRatio', value: n(mobility.verticalRatio, 1), unit: t('activity.units.percent') },
  ].filter((tile): tile is Tile => tile !== null)

  return (
    <Card span={12} label={t('activity.workout.dynamics.label')}>
      <div className="workout-dynamics">
        {tiles.map((tile) => (
          <StatTile key={tile.key} label={t(`activity.workout.dynamics.${tile.key}`)}
            value={tile.value} unit={tile.unit} basis={t('activity.workout.basis.provider')} />
        ))}
      </div>
    </Card>
  )
}
