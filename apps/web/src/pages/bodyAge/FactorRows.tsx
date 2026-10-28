import { useTranslation } from '../../i18n/index.js'
import type { Translate } from '../../format.js'
import { formatNumber, formatSignedNumber } from '../../format.js'
import { Card } from '../../components/Card.js'
import { verdictTone } from '../../components/FigureRow.js'
import { emphasise } from '../detail/periodText.js'
import { EmphasisedText } from '../period/EmphasisedText.js'
import type { BodyAgeAvailable, BodyAgeFactor, BodyAgeFactorKey, BodyAgeMethod } from '../../data/useBodyAge.js'

const SEPARATOR = ' · '
const NBSP = ' '

// Each factor's value at the precision the server rounded it to (routes/v1/bodyAge.ts): a VO2
// reading and sessions a week to a tenth, the rest whole. A whole tenth-precision value drops its
// ".0" ("1 a week", "47 ml/kg/min"), as the Activity page prints its VO2 max.
const PRECISION: Record<BodyAgeFactorKey, number> = {
  vo2Max: 1, restingHeartRate: 0, activity: 0, sleepRegularity: 0, strength: 1,
}
const precisionOf = (key: BodyAgeFactorKey, value: number): number => (Number.isInteger(value) ? 0 : PRECISION[key])

/**
 * Years in a factor's direction, as a verdict's tone: fewer years (younger) the better side, more
 * the worse, none plain. The sign is the server's; this only names the colour it takes, as
 * verdictTone does for a judged figure on every other page.
 */
export function yearsTone(years: number): 'better' | 'worse' | null {
  return verdictTone(years < 0 ? 'better' : years > 0 ? 'worse' : null, null) as 'better' | 'worse' | null
}

/** Signed years to a tenth, "-3.0 years", "+0.6 years", "0.0 years". */
export function yearsText(years: number, language: string, t: Translate): string {
  return t('bodyAge.factors.years', { years: formatSignedNumber(years, 1, language, t('common.absent')) })
}

/**
 * A contribution drawn around zero (PATTERNS.md's "Diverging contribution bar"): FigureRow's 8px
 * track with a hairline at its centre, filled from the centre to the left for a negative value and
 * to the right for a positive one, each side running out to `cap`, so a factor at its limit fills
 * its whole half. The fill takes the tone of the words beside it. Drawn only: the years are printed
 * beside it, so it is hidden from assistive tech, as FigureRow's bar is.
 */
export function DivergingBar({ value, cap, tone }: { value: number, cap: number, tone: 'better' | 'worse' | null }) {
  const half = cap <= 0 ? 0 : Math.min(Math.abs(value) / cap, 1) * 50
  const style = value < 0 ? { right: '50%', width: `${half}%` } : { left: '50%', width: `${half}%` }
  return (
    <div className="diverging-bar" aria-hidden="true">
      <span className="diverging-bar-centre" />
      {half > 0 && <span className={tone === null ? 'diverging-bar-fill' : `diverging-bar-fill ${tone}`} style={style} />}
    </div>
  )
}

function compareLine(factor: BodyAgeFactor, current: BodyAgeAvailable, method: BodyAgeMethod, language: string, t: Translate): string {
  const { key, value, reference } = factor
  const absent = t('common.absent')
  const parts: string[] = []
  if (value !== null && reference !== null) {
    const side = value > reference ? 'above' : value < reference ? 'below' : 'at'
    parts.push(t(`bodyAge.factors.compare.${key}.${side}`, {
      reference: formatNumber(reference, precisionOf(key, reference), language, absent), days: method.windowDays,
    }))
  }
  if (key === 'vo2Max' && current.fitnessAge !== null) {
    parts.push(t('bodyAge.factors.fitnessAge', { age: formatNumber(current.fitnessAge, 1, language, absent) }))
  }
  if (factor.capped) {
    const cap = method.factors.find((spec) => spec.key === key)?.cap
    if (cap !== undefined) parts.push(t('bodyAge.factors.capped', { cap: formatNumber(cap, Number.isInteger(cap) ? 0 : 1, language, absent) }))
  }
  return parts.join(SEPARATOR)
}

function FactorRow({ factor, current, method }: { factor: BodyAgeFactor, current: BodyAgeAvailable, method: BodyAgeMethod }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { key } = factor
  const name = t(`bodyAge.factors.names.${key}`)
  const inline = t(`bodyAge.factors.inline.${key}`)
  const cap = method.factors.find((spec) => spec.key === key)?.cap ?? 0

  if (factor.missing !== null || factor.value === null) {
    const note = factor.missing === 'tooFewDays'
      ? t('bodyAge.factors.tooFewDays', { days: factor.days, factor: inline, min: method.minFactorDays })
      : t('bodyAge.factors.noReading', { factor: inline, days: method.windowDays })
    return (
      <div className="body-age-factor">
        <div className="body-age-factor-text">
          <span className="label figure-row-label">{name}</span>
          <span className="body-age-factor-note">{note}</span>
        </div>
      </div>
    )
  }

  const tone = yearsTone(factor.years)
  const number = formatNumber(factor.value, precisionOf(key, factor.value), language, t('common.absent'))
  return (
    <div className="body-age-factor">
      <div className="body-age-factor-text">
        <span className="label figure-row-label">{name}</span>
        <span className="figure-row-value">
          {key === 'sleepRegularity' ? `±${number}` : number}{NBSP}<span className="figure-row-unit">{t(`bodyAge.factors.units.${key}`)}</span>
        </span>
        <span className="body-age-factor-note">{compareLine(factor, current, method, language, t)}</span>
      </div>
      <DivergingBar value={factor.years} cap={cap} tone={tone} />
      <span className={tone === null ? 'body-age-factor-years' : `body-age-factor-years ${tone}`}>{yearsText(factor.years, language, t)}</span>
    </div>
  )
}

/**
 * "What moves it": a row per factor, in the server's order (its name and value, how the value
 * sits against the typical one for the person's age and sex, the bar of its years against its own
 * cap, and the years in their tone), a factor that does not count saying why, then the one factor
 * with the most room when the server names one. A caption under the rows says what a bar is.
 */
export function FactorRows({ current, method }: { current: BodyAgeAvailable, method: BodyAgeMethod }) {
  const { t, i18n } = useTranslation()
  const room = current.mostRoom
  return (
    <Card span={12} label={t('bodyAge.factors.label')}>
      <div className="body-age-factors">
        {current.factors.map((factor) => <FactorRow key={factor.key} factor={factor} current={current} method={method} />)}
      </div>
      {room !== null && (
        <p className="body-age-room"><EmphasisedText line={emphasise(t, 'bodyAge.factors.room', {
          factor: t(`bodyAge.factors.inline.${room.key}`),
          // What reaching the typical level would take off: the years the factor adds now.
          years: formatNumber(room.years, 1, i18n.language, t('common.absent')),
        }, ['factor', 'years'])} /></p>
      )}
      <p className="dash-caption">{t('bodyAge.factors.caption')}</p>
    </Card>
  )
}
