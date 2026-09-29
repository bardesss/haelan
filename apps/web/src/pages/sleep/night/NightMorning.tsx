import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow } from '../../../components/FigureRow.js'
import type { FigureRowStrip } from '../../../components/FigureRow.js'
import { ScoreRing } from '../../dashboard/ScoreRing.js'
import { formatLocalDate, formatSignedNumber } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { usualLine } from '../../dashboard/glanceText.js'
import type { NightPageData, PageFigure } from '../../../data/useNightPage.js'
import { deviationVerdictLine, formatFigureValue, stripOf, verdictLine } from './figureText.js'

// Which readings draw a trend (a strip) rather than today's reading alone against its band (a
// bar): the spec's and the mockup's own split, resting heart rate, HRV and skin temperature get the
// former, breathing and oxygen the latter, not "whichever figure happens to carry a strip on the
// wire".
const ROWS = [
  { key: 'restingHeartRate', withStrip: true },
  { key: 'hrv', withStrip: true },
  { key: 'breathing', withStrip: false },
  { key: 'spo2', withStrip: false },
  { key: 'skinTemperature', withStrip: true },
] as const

// What the recovery index is made of, in its own words: core's four inputs (hrv, restingHeartRate,
// respiratoryRate, sleep), with sleep named as the two halves it stands on, duration and bedtime
// consistency (packages/core/src/api/recoveryIndex.ts's sleepWeekSeries).
const INPUTS = [
  { input: 'hrv', words: ['hrv'] },
  { input: 'restingHeartRate', words: ['restingHeartRate'] },
  { input: 'respiratoryRate', words: ['respiratoryRate'] },
  { input: 'sleep', words: ['sleep', 'bedtime'] },
] as const

/** "from HRV, resting heart rate, breathing, sleep and bedtime", leaving out what the index went without. */
function madeOf(missing: readonly string[] | null, t: Translate): string | null {
  const words = INPUTS
    .filter(({ input }) => !(missing ?? []).includes(input))
    .flatMap(({ words: keys }) => keys.map((key) => t(`sleep.night.morning.inputs.${key}`)))
  if (words.length === 0) return null
  const inputs = words.length === 1
    ? words[0]!
    : t('sleep.night.morning.and', { rest: words.slice(0, -1).join(', '), last: words.at(-1)! })
  return t('sleep.night.morning.from', { inputs })
}

/**
 * The morning after this night: the recovery index as a ring, and beside it the five readings that
 * make it up or accompany it, each against its own usual. The mockup's "De ochtend erna".
 *
 * Labelled "The morning after" only when the recovery the server scored is THIS night's own
 * morning (M10a-1's ruling, restated in constraints.md); a recovery that belongs to a different
 * day - the picker can still reach a night whose morning has not synced yet, or one recovery
 * skipped - names its own date instead, so the card never claims a morning it is not showing. A
 * recovery with no date at all (never scored) falls back to the plain label rather than trying to
 * print one.
 *
 * Skin temperature is printed as a signed deviation from the usual ("+0.6 °C"), not the raw reading
 * ("33.6 °C") - the one figure on this page the mockup reads as a departure rather than a value -
 * and its verdict names the usual as a deviation too (deviationVerdictLine). Its strip still plots
 * the raw nightly readings against their raw bands: only the printed text changes.
 *
 * Under the ring: the band in words, the index's own usual (the glance's usualLine, the same words
 * the dashboard's recovery card uses), and what the index is made of.
 *
 * Absent entirely when the morning has nothing at all - no score and no reading - the same
 * closing-up every other section of this page does when it has nothing to draw (NightHero's own
 * comment on why).
 */
export function NightMorning({ page }: { page: NightPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { morning, localDate } = page
  const { recovery } = morning

  const rows = useMemo(() => {
    const figuresByKey: Record<(typeof ROWS)[number]['key'], PageFigure> = {
      restingHeartRate: morning.restingHeartRate, hrv: morning.hrv, breathing: morning.breathing,
      spo2: morning.spo2, skinTemperature: morning.skinTemperature,
    }
    return ROWS.flatMap(({ key, withStrip }) => {
      const figure = figuresByKey[key]
      if (figure.value === null) return []
      const label = t(`sleep.night.morning.${key}`)
      // Skin temperature reads as a deviation only when the server could compute one; with no
      // usual to deviate from (a thin or absent baseline) it reads as the reading itself, never
      // as "— °C".
      const deviation = key === 'skinTemperature' ? morning.skinTemperatureDeviation : null
      const value = deviation !== null
        ? `${formatSignedNumber(deviation, figure.precision, language, t('common.absent'))} ${t('charts.units.celsius')}`
        : formatFigureValue(figure, figure.value, language, t)
      // A row with no usual at all (rather than a thin one, which verdictLine already words) still
      // needs something in its hidden strip description: an empty string there reads as no
      // description at all, which is not the same fact as "nothing to compare against".
      const verdict = (deviation !== null ? deviationVerdictLine(figure, language, t) : verdictLine(figure, language, t))
        ?? t('glance.usual.none')
      const drawn = withStrip ? stripOf(figure) : null
      const strip: FigureRowStrip | undefined = drawn === null ? undefined : {
        ...drawn, metric: figure.metric, unit: label,
        // HRV is charted twice on this page, through the night and here; the name says which.
        ...(key === 'hrv' && { label: t('sleep.night.morning.hrvChart') }),
        formatValue: (v, absent) => (v === null ? absent : formatFigureValue(figure, v, language, t)),
      }
      return [{ key, label, value, verdict, figure, strip }]
    })
  }, [morning, language, t])

  const score = recovery.index.value
  if (rows.length === 0 && score === null) return null

  const asOfDate = recovery.index.asOfDate
  const label = asOfDate !== null && asOfDate !== localDate
    ? t('sleep.night.morning.labelDated', { date: formatLocalDate(asOfDate, language) })
    : t('sleep.night.morning.label')
  const bandWords = recovery.band === null ? null : t(`recoveryIndex.band.${recovery.band}`)
  const recoveryUsual = usualLine(recovery.index, t, language)
  const from = madeOf(recovery.missing, t)
  const ringLabel = score === null
    ? t('glance.recovery.scoreUnscored')
    : [`${t('glance.recovery.index')} ${Math.round(score)}`, bandWords].filter(Boolean).join(', ')

  return (
    <Card span={12} label={label}>
      <div className="night-grp">
        <div className="dash-dial">
          <ScoreRing value={score} size={150} emptyText={t('glance.recovery.notScored')} label={ringLabel} />
          {bandWords !== null && <p className="dash-recovery-words">{bandWords}</p>}
          {recoveryUsual !== null && <p className="night-recovery-usual">{recoveryUsual}</p>}
          {from !== null && <p className="night-recovery-from">{from}</p>}
        </div>
        {rows.length > 0 && (
          <div className="night-morning-rows">
            {rows.map(({ key, label: rowLabel, value, verdict, figure, strip }) => (
              <FigureRow key={key} label={rowLabel} value={value} verdict={verdict} judged={figure.judged}
                band={figure.baseline} mark={figure.value} strip={strip} />
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
