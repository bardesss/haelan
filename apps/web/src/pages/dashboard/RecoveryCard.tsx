import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Sparkline } from '../../charts/Sparkline.js'
import type { GlanceFigure, GlanceRecovery } from '../../data/useGlance.js'
import { DashCard, Described } from './cardShared.js'
import { ScoreRing } from './ScoreRing.js'
import { UsualGauge } from './UsualGauge.js'
import { formatFigure, usualLine, asOfLine, yesterdayOf } from './glanceText.js'

/**
 * Recovery as three dials: the index as a ring in the middle (0-100 is a real scale), resting heart
 * rate and HRV as gauges against their usual either side, the band's words under them. Wide (the row
 * to itself: no night, or the 900-1200px band) puts the seven-day index strip beside the dials.
 * An unscored day draws an empty ring and says why once; the gauges still draw what they have, each
 * naming its day when it is not the card's.
 */
export function RecoveryCard({ recovery, span, wide, today, timezone }: {
  recovery: GlanceRecovery, span: 4 | 12, wide: boolean, today: string, timezone: string
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const small = !wide
  const gaugeSize = small ? 100 : 120
  const ringSize = small ? 124 : 150
  const subtitle = recovery.index.asOfDate === today ? t('glance.subtitle.today')
    : recovery.index.asOfDate !== null && recovery.index.asOfDate === yesterdayOf(today) ? t('glance.subtitle.yesterday') : null
  const gauge = (key: 'rhr' | 'hrv', figure: GlanceFigure, unit: string) => {
    if (figure.value === null) return <div className="dash-dial"><p className="glance-empty">{t('glance.noReading')}</p><span className="label">{t(`glance.recovery.${key}`)}</span></div>
    const usual = usualLine(figure, t, language)
    const day = figure.asOfDate !== recovery.index.asOfDate ? asOfLine(figure, { today, timezone }, t, language) : null
    const band = figure.baseline !== null && !figure.baseline.thin ? figure.baseline : null
    return (
      <div className="dash-dial">
        <UsualGauge value={figure.value} unit={unit} baseline={band} standing={figure.standing} size={gaugeSize}
          label={[`${t(`glance.recovery.${key}`)} ${formatFigure(figure, language)} ${unit}`, usual].filter(Boolean).join(', ')} />
        <span className="label">{t(`glance.recovery.${key}`)}</span>
        {day !== null && <span className="glance-asof">{day}</span>}
      </div>
    )
  }
  const index = recovery.index
  const score = index.value
  const bandWords = recovery.band === null ? null : t(`recoveryIndex.band.${recovery.band}`)
  const dials = (
    <div className="dash-dials">
      {gauge('rhr', recovery.restingHeartRate, t('charts.units.bpm'))}
      <div className="dash-dial">
        <ScoreRing value={score} size={ringSize} emptyText={t('glance.recovery.notScored')}
          label={score === null ? t('glance.recovery.score') : [`${t('glance.recovery.index')} ${Math.round(score)}`, bandWords].filter(Boolean).join(', ')} />
        <span className="label">{t('glance.recovery.score')}</span>
      </div>
      {gauge('hrv', recovery.hrv, t('charts.units.milliseconds'))}
    </div>
  )
  // The seven-day index strip. Always in the markup; CSS shows it only when the card has the row to
  // itself (.is-wide) or in the 900-1200px band, where the grid gives every dashboard card span 12.
  const { values, labels, standings } = useMemo(() => ({
    values: index.strip.map((d) => d.value), labels: index.strip.map((d) => d.localDate),
    standings: index.strip.map((d) => d.standing),
  }), [index.strip])
  const strip = values.filter((v) => v !== null).length > 1 ? (
    <div className="dash-recovery-strip">
      <Described text={t('glance.recovery.caption')} hidden>
        <Sparkline values={values} labels={labels} label={t('glance.recovery.strip')} unit={t('glance.recovery.index')}
          metric={index.metric} height={64} dots pointStandings={standings} tableToggle={false}
          formatValue={(v, absent) => (v === null ? absent : String(Math.round(v)))} />
      </Described>
      <p className="dash-caption">{t('glance.recovery.caption')}</p>
    </div>
  ) : null
  return (
    <DashCard span={span} title={t('glance.recovery.title')} subtitle={subtitle} className={wide ? 'dash-recovery is-wide' : 'dash-recovery'}
      link={{ to: '/recovery', text: t('glance.recovery.link') }} staleFigures={[index, recovery.restingHeartRate, recovery.hrv]}>
      <div className="dash-recovery-row">{dials}{strip}</div>
      <p className="dash-recovery-words">{score === null ? t('glance.recovery.unscored') : bandWords}</p>
      {recovery.respiratoryRate !== null && (
        <p className="glance-note">{t('glance.recovery.respiratory', { value: `${formatFigure(recovery.respiratoryRate, language)} ${t('recovery.units.breathsPerMinuteShort')}` })}</p>
      )}
    </DashCard>
  )
}
