import { useId, useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import type { Translate } from '../../format.js'
import { formatNumber, formatSignedNumber } from '../../format.js'
import { Card } from '../../components/Card.js'
import { BasisContext } from '../../components/basis.js'
import { Sparkline } from '../../charts/Sparkline.js'
import type { BodyAgeAvailable, BodyAgeMonth, BodyAgeRead } from '../../data/useBodyAge.js'
import { emphasise } from '../detail/periodText.js'
import type { Emphasised } from '../detail/periodText.js'
import { EmphasisedText } from '../period/EmphasisedText.js'
import { yearsTone } from './FactorRows.js'

/** An age or a number of years to a tenth, as the server rounds them. */
const tenth = (value: number, language: string, t: Translate) => formatNumber(value, 1, language, t('common.absent'))

/** A month by name and year ("July 2026"): the history runs across years, so the year is said. */
function monthAndYear(month: string, language: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString(language, { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/**
 * The lines under the verdict, a line each and each left out when the read has nothing for it
 * (PeriodHero's stood-out lines, in its markup): the pace over the last twelve months, the change
 * against the window before, the youngest month on record when it was younger, and the factor that
 * carried the figure. The value each turns on is bold.
 */
export function heroLines(read: BodyAgeRead, current: BodyAgeAvailable, language: string, t: Translate): Emphasised[] {
  const absent = t('common.absent')
  const lines: Emphasised[] = []
  if (read.pace !== null) {
    lines.push(emphasise(t, 'bodyAge.hero.pace', { pace: formatNumber(read.pace, 2, language, absent) }, ['pace']))
  }
  if (read.previous !== null) {
    // Between the two ages as printed, so the line adds up with the figures beside it.
    const delta = (Math.round(current.bodyAge * 10) - Math.round(read.previous.bodyAge * 10)) / 10
    lines.push(emphasise(t, 'bodyAge.hero.previous', {
      delta: formatSignedNumber(delta, 1, language, absent), days: read.method.windowDays,
    }, ['delta']))
  }
  if (read.youngest !== null && read.youngest.gap < 0) {
    lines.push(emphasise(t, 'bodyAge.hero.youngest', {
      years: tenth(-read.youngest.gap, language, t), month: monthAndYear(read.youngest.month, language),
    }, ['years']))
  }
  if (current.carriedBy !== null) {
    lines.push(emphasise(t, 'bodyAge.hero.carriedBy', { factor: t(`bodyAge.factors.inline.${current.carriedBy}`) }, ['factor']))
  }
  return lines
}

/** The verdict: how far from the calendar age, and which way, toned as the years are. */
function verdictOf(current: BodyAgeAvailable, language: string, t: Translate): string {
  const age = tenth(current.calendarAge, language, t)
  const years = tenth(Math.abs(current.gap), language, t)
  if (current.gap < 0) return t('bodyAge.hero.younger', { years, age })
  if (current.gap > 0) return t('bodyAge.hero.older', { years, age })
  return t('bodyAge.hero.same', { age })
}

/** The month after `YYYY-MM`. */
function nextMonth(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number]
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, '0')}`
}

/** The last day of `YYYY-MM`, the date a month the server left out is labelled by. */
function monthEnd(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10)
}

/**
 * Every month from the first on record to the last, the ones core withheld as null, so the strip
 * draws a gap where there is no body age rather than joining the months either side (the spec's
 * "gaps, not zeros"). A month on record keeps its own end date as its label.
 */
export function denseMonths(months: readonly BodyAgeMonth[]): { label: string, month: BodyAgeMonth | null }[] {
  const first = months[0]
  const last = months[months.length - 1]
  if (first === undefined || last === undefined) return []
  const byMonth = new Map(months.map((month) => [month.month, month]))
  const slots: { label: string, month: BodyAgeMonth | null }[] = []
  for (let month = first.month; month <= last.month; month = nextMonth(month)) {
    const found = byMonth.get(month) ?? null
    slots.push({ label: found?.endDate ?? monthEnd(month), month: found })
  }
  return slots
}

/**
 * The page's lead, PeriodHero's markup over the body age read (PATTERNS.md's hero): the body age
 * over the window in display type, the verdict against the calendar age in the verdict's tone,
 * the quiet lines under it, and beside them a strip of the months on record (a gap for each month
 * without a body age), the calendar age as
 * its dashed reference line (Sparkline's `reference`) and the youngest month ringed when it was
 * younger, the range the two lines span labelled at its left edge. One point joins nothing, so
 * the strip needs two months.
 */
export function BodyAgeHero({ read, current }: { read: BodyAgeRead, current: BodyAgeAvailable }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const verdictId = useId()
  const { months } = read
  const label = t('bodyAge.title')
  const strip = useMemo(() => {
    if (months.length < 2) return null
    const slots = denseMonths(months)
    const youngest = read.youngest !== null && read.youngest.gap < 0 ? read.youngest.month : null
    // The range both lines span, labelled at the strip's left edge as every hero strip's band is,
    // so the reader can read the ages off it.
    const ages = months.flatMap((month) => [month.bodyAge, month.calendarAge])
    const low = Math.min(...ages)
    const high = Math.max(...ages)
    return {
      // Labels with no band (Sparkline's rangeLabels): a band would say "your usual", which a
      // body age has none of.
      range: { low, high, lowText: formatNumber(low, 1, language, t('common.absent')), highText: formatNumber(high, 1, language, t('common.absent')) },
      values: slots.map((slot) => slot.month?.bodyAge ?? null),
      labels: slots.map((slot) => slot.label),
      // Null in the gaps too; Sparkline joins its reference line across them, the readings it breaks.
      reference: { values: slots.map((slot) => slot.month?.calendarAge ?? null), label: t('bodyAge.hero.calendarAge') },
      marks: slots.map((slot) => (slot.month !== null && slot.month.month === youngest ? 'good' as const : undefined)),
    }
  }, [months, read.youngest, language, t])
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null ? absent : formatNumber(value, 1, language, absent)),
    [language],
  )

  const tone = yearsTone(current.gap)
  const lines = heroLines(read, current, language, t)
  return (
    <Card span={12} label={t('bodyAge.hero.label', { days: read.method.windowDays })}>
      <div className="dash-lead detail-hero">
        <div>
          <div className="dash-headline detail-hero-value">{tenth(current.bodyAge, language, t)}</div>
          <p id={verdictId} className={tone === null ? 'detail-verdict' : `detail-verdict ${tone}`}>{verdictOf(current, language, t)}</p>
          {lines.map((line, index) => <p key={index} className="workout-hero-line"><EmphasisedText line={line} /></p>)}
        </div>
        {strip !== null && (
          <div className="dash-lead-strip period-hero-strip">
            <BasisContext.Provider value={verdictId}>
              <Sparkline values={strip.values} labels={strip.labels} label={label} unit={label} metric="body_age"
                formatValue={formatValue} reference={strip.reference} pointMarks={strip.marks}
                rangeLabels={strip.range}
                height={64} dots tableToggle={false} />
            </BasisContext.Provider>
            <div className="period-hero-captions">
              <p className="dash-caption">{t('bodyAge.hero.caption', { days: read.method.windowDays })}</p>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
