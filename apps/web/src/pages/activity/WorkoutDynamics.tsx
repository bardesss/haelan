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
    // The basis sits on the Card, not on each tile. Every one of these five is read straight off
    // the payload, so a basis per tile printed one identical sentence five times; said once above
    // them it is the same claim, made once.
    <Card span={12} label={t('activity.workout.dynamics.label')}
      basis={t('activity.workout.basis.provider')}>
      <div className="workout-dynamics">
        {/* The wrapper is load bearing. StatTile is a fragment - a header, a value and a basis as
            three siblings, with the box left to its caller - and every other call site gives it a
            Card. Dropped bare into this grid, each tile contributed three grid items instead of
            one, so five tiles became fifteen and the browser laid label, value and basis out in a
            single run across the row. A Card each would fix it and cost the group label above
            them, which is the one thing saying these five are a set. */}
        {tiles.map((tile) => (
          <div key={tile.key} className="workout-dynamic-tile">
            <StatTile label={t(`activity.workout.dynamics.${tile.key}`)}
              value={tile.value} unit={tile.unit} />
          </div>
        ))}
      </div>
    </Card>
  )
}
