import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow } from '../../../components/FigureRow.js'
import type { FigureRowStrip } from '../../../components/FigureRow.js'
import { ScoreRing } from '../../dashboard/ScoreRing.js'
import { formatLocalDate, formatSignedNumber } from '../../../format.js'
import type { NightPageData, PageFigure } from '../../../data/useNightPage.js'
import { formatFigureValue, stripOf, verdictLine } from './figureText.js'

// Which readings draw a trend (a strip) rather than today's reading alone against its band (a
// bar): the mockup's own split, resting heart rate and HRV get the former, breathing, oxygen and
// skin temperature the latter, not "whichever figure happens to carry a strip on the wire".
const ROWS = [
  { key: 'restingHeartRate', withStrip: true },
  { key: 'hrv', withStrip: true },
  { key: 'breathing', withStrip: false },
  { key: 'spo2', withStrip: false },
  { key: 'skinTemperature', withStrip: false },
] as const

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
 * Skin temperature is drawn as a signed deviation from the usual ("+0.6 °C"), not the raw reading
 * ("33.6 °C") - the one figure on this page the mockup reads as a departure rather than a value.
 * Its bar still positions the raw reading against the raw band (`mark={figure.value}`,
 * `band={figure.baseline}`): only the printed text and the formatter reading it change.
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
      const value = key === 'skinTemperature'
        ? `${formatSignedNumber(morning.skinTemperatureDeviation, figure.precision, language, t('common.absent'))} ${t('charts.units.celsius')}`
        : formatFigureValue(figure, figure.value, language, t)
      // A row with no usual at all (rather than a thin one, which verdictLine already words) still
      // needs something in its hidden strip description: an empty string there reads as no
      // description at all, which is not the same fact as "nothing to compare against".
      const verdict = verdictLine(figure, language, t) ?? t('recovery.baselineNote.none')
      const drawn = withStrip ? stripOf(figure) : null
      const strip: FigureRowStrip | undefined = drawn === null ? undefined : {
        ...drawn, metric: figure.metric, unit: label,
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
  const ringLabel = score === null
    ? t('glance.recovery.scoreUnscored')
    : [`${t('glance.recovery.index')} ${Math.round(score)}`, bandWords].filter(Boolean).join(', ')

  return (
    <Card span={12} label={label}>
      <div className="night-grp">
        <div className="dash-dial">
          <ScoreRing value={score} size={150} emptyText={t('glance.recovery.notScored')} label={ringLabel} />
          {bandWords !== null && <p className="dash-recovery-words">{bandWords}</p>}
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
