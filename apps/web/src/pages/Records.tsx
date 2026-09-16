import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { ErrorState } from '../components/ErrorState.js'
import { Loading } from '../components/Loading.js'
import { formatLocalDate, formatMetricValue, formatNumber } from '../format.js'
import { useAllTime } from '../data/useAllTime.js'
import type { AllTime, MetricRecord, Milestone } from '../data/useAllTime.js'

/**
 * What only the whole archive can answer.
 *
 * **This page deliberately has no ControlRow**, and it is the only page in the app without one.
 * Every figure here ignores the range by definition, so a range picker would be a control that
 * either lies or does nothing, and a source picker would be worse: a record is a merged figure
 * and two of the five metrics have no per-source rows at all. The span line below does the one
 * job the control row really did - telling the reader what they are looking at - and it is not
 * decoration: an all-time number that does not name its window is the failure the M6-0 probe
 * warned about, since this archive's steps begin eight months after its first row.
 *
 * The cost, accepted when this was designed: runSync lives only in ControlRow, so there is no
 * sync button here. Every other page keeps one.
 */
export function Records() {
  const { t, i18n } = useTranslation()
  const { all, isPending, isError, error, refetch } = useAllTime()

  if (isPending) return <Loading />
  if (isError) return <ErrorState onRetry={refetch} error={error} />
  if (all === undefined) return <ErrorState onRetry={refetch} error={undefined} />

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>
        {t('records.title')}
      </h1>
      {all.span.days === 0
        ? <p className="all-time-empty">{t('records.empty')}</p>
        : <AllTimeBody all={all} t={t} language={i18n.language} />}
    </>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

// formatLocalDate, not a local reimplementation of it. The shared helper pins `timeZone: 'UTC'`
// and its own comment names the failure of leaving it out: a reader west of Greenwich is shown
// the day before, because a bare 'YYYY-MM-DD' is UTC midnight and toLocaleString would read it
// back in the browser's zone. This file had its own copy of that formatting, without the pin.
const onDate = formatLocalDate

/**
 * A record's value as a person reads it, which is not always the number in the row.
 *
 * `distance` is stored in millimetres (METRICS.distance, precision 0), so the catalogue's own
 * formatter would render a ten kilometre day as "10,000,000". Every other surface in this app
 * converts at the point of display for exactly this metric; this is that conversion, in the one
 * place this page needs it. Every other metric goes through formatMetricValue so its precision
 * comes off the catalogue rather than off a literal here.
 */
function recordValue(metric: string, value: number, language: string): string {
  if (metric === 'distance') return `${formatNumber(value / 1_000_000, 1, language, '')} km`
  return formatMetricValue(value, metric, language, '')
}

function AllTimeBody({ all, t, language }: { all: AllTime, t: Translate, language: string }) {
  return (
    <>
      <p className="all-time-span">
        {t('records.span', {
          from: onDate(all.span.from, language),
          to: onDate(all.span.to, language),
          days: all.span.days,
        })}
      </p>

      <div className="grid">
        {all.records.length > 0 && (
          <Card span={12} label={t('records.bests.label')} basis={t('records.bests.basis')}>
            <ul className="record-list">
              {all.records.map((record) => (
                <RecordRow key={record.metric} record={record} t={t} language={language} />
              ))}
            </ul>
          </Card>
        )}

        {all.eddington !== null && (
          <Card span={6} label={t('records.eddington.label')}>
            <p className="eddington-value">{all.eddington.e}</p>
            <p className="eddington-meaning">
              {t('records.eddington.meaning', { e: all.eddington.e })}
            </p>
            {/* Its own window, not the page's. The two differ by eight months on the archive
                this was designed against, and a figure labelled all-time that quietly covers a
                third of it is exactly what the probe said to avoid. */}
            <p className="eddington-window">
              {t('records.eddington.window', {
                days: all.eddington.days,
                from: onDate(all.eddington.from, language),
              })}
            </p>
          </Card>
        )}

        {all.milestones.length > 0 && (
          <Card span={6} label={t('records.milestones.label')}>
            <ol className="milestone-list">
              {all.milestones.map((milestone) => (
                <MilestoneRow
                  key={`${milestone.kind}-${milestone.metric ?? ''}-${milestone.count ?? milestone.days ?? 0}-${milestone.localDate}`}
                  milestone={milestone} t={t} language={language}
                />
              ))}
            </ol>
          </Card>
        )}
      </div>
    </>
  )
}

function RecordRow({ record, t, language }: {
  record: MetricRecord, t: Translate, language: string
}) {
  return (
    // A data attribute rather than a `record-${metric}` class: a templated class name leaves a
    // bare `record-` that no stylesheet defines, which css-classes.test.ts is right to refuse,
    // and every class in this app stays greppable as written.
    <li className="record-row" data-metric={record.metric}>
      <span className="record-metric">{t(`records.metric.${record.metric}`)}</span>
      <span className="record-value">{recordValue(record.metric, record.value, language)}</span>
      <span className="record-date">{onDate(record.localDate, language)}</span>
      {/* The metric's own history, which is not the page's: floors and total_calories reach
          back further than steps do on a real archive, and a record means less without knowing
          how many days it beat. */}
      <span className="record-window">
        {t('records.bests.outOf', { days: record.days, from: onDate(record.from, language) })}
      </span>
    </li>
  )
}

function MilestoneRow({ milestone, t, language }: {
  milestone: Milestone, t: Translate, language: string
}) {
  // Every branch reads its copy from a key of its own rather than assembling a sentence from
  // fragments: Dutch does not order these the way English does.
  const label = milestone.kind === 'record'
    ? t('records.milestones.record', { metric: t(`records.metric.${milestone.metric}`) })
    : milestone.kind === 'first'
      // "First recorded", never "first": this marks when syncing began rather than anything
      // about the person, and the copy has to be honest about which.
      ? t(`records.milestones.first.${milestone.metric}`)
      : milestone.kind === 'count'
        // Through formatNumber like every other figure on this page: the step crossings are
        // millions, and i18next interpolates a raw 1000000 unless somebody formats it.
        ? t(`records.milestones.count.${milestone.metric}`, {
          count: milestone.count,
          formatted: formatNumber(milestone.count ?? null, 0, language, ''),
        })
        : t('records.milestones.run', { days: milestone.days })

  return (
    <li className="milestone" data-kind={milestone.kind}>
      <span className="milestone-date">{onDate(milestone.localDate, language)}</span>
      <span className="milestone-label">{label}</span>
    </li>
  )
}
