import { useTranslation } from '../i18n/index.js'
import { effortDistancesOf } from '@haelan/core/fastest-efforts'
import { PLAIN_TYPE, RECORD_CATEGORY_ORDER } from '@haelan/core/exercise-category'
import type { ExerciseCategory } from '@haelan/core/exercise-category'
import { Card } from '../components/Card.js'
import { ErrorState } from '../components/ErrorState.js'
import { Icon } from '../components/icons.js'
import { Loading } from '../components/Loading.js'
import { Link } from '../router.js'
import { formatLocalDate, formatMetricValue, formatNumber } from '../format.js'
import { exerciseTypeLabel } from '../data/exerciseTypeLabel.js'
import { CATEGORY_ICONS } from './activity/SessionRow.js'
import { sessionRateText, swimDistanceText, valueAs } from './activity/categoryText.js'
import { workoutPath } from './activity/workout/workoutText.js'
import { useAllTime } from '../data/useAllTime.js'
import { sourceLabel } from '../data/useSourceNames.js'
import { useSession } from '../auth/session.js'
import { localToday } from '../controls/range.js'
import type { AllTime, MetricRecord, Milestone, SessionRecord } from '../data/useAllTime.js'
import { formatFigureValue } from './detail/figureText.js'

/**
 * What only the whole archive can answer.
 *
 * **This page deliberately has no ControlRow**, the first page in the app without one (the glance
 * Dashboard followed in M9b, for the same reason).
 * Every figure here ignores the range by definition, so a range picker would be a control that
 * either lies or does nothing, and a source picker would be worse: a record is a merged figure
 * and two of the five metrics have no per-source rows at all. The span line below does the one
 * job the control row really did - telling the reader what they are looking at - and it is not
 * decoration: an all-time number that does not name its window is the failure the M6-0 probe
 * warned about, since this archive's steps begin eight months after its first row.
 *
 * Dropping the control row costs this page nothing else: the sync button used to live in
 * ControlRow, which left this page without one when it was designed, but it has since moved to the
 * shell's rail (StatusControl.tsx, the status panel beside the reader's name), which every page shows.
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
function recordValue(metric: string, value: number, language: string, t: Translate): string {
  if (metric === 'distance') return `${formatNumber(value / 1_000_000, 1, language, '')} ${t('activity.units.km')}`
  return formatMetricValue(value, metric, language, '')
}

/**
 * The session records by category, in RECORD_CATEGORY_ORDER (run, ride, walk, swim, then the ones
 * that keep only a longest session), each keeping the order the server listed its kinds in. A
 * category with no record has no group, so no card.
 */
function recordGroups(records: readonly SessionRecord[]): { category: ExerciseCategory, records: SessionRecord[] }[] {
  return RECORD_CATEGORY_ORDER
    .map((category) => ({ category, records: records.filter((r) => r.category === category) }))
    .filter((group) => group.records.length > 0)
}

function AllTimeBody({ all, t, language }: { all: AllTime, t: Translate, language: string }) {
  const groups = recordGroups(all.sessionRecords)
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
            <ul className="record-list list-measured">
              {all.records.map((record) => (
                <RecordRow key={record.metric} record={record} t={t} language={language} />
              ))}
            </ul>
          </Card>
        )}

        {/* A card per category that holds a record, labelled by the category with its glyph: a
            ride never sits in a run's list. Half width each, a uniform run; a lone one takes the
            row (PATTERNS.md's span rule), since nothing pairs with it. */}
        {groups.map(({ category, records }) => (
          <Card key={category} span={groups.length === 1 ? 12 : 6} label={t(`records.categories.${category}`)}
            labelIcon={(
              <span className="session-row-icon card-label-icon" data-category={category} aria-hidden="true">
                <Icon name={CATEGORY_ICONS[category]} />
              </span>
            )}>
            <ul className="record-list list-measured" data-category={category}>
              {records.map((record) => (
                <SessionRecordRow key={record.kind} record={record} t={t} language={language} />
              ))}
            </ul>
          </Card>
        ))}

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
  // The person's today, for sourceLabel's year rule - their zone, as every other surface reads it.
  const session = useSession()
  const today = localToday(session.data?.effectiveTimezone)
  return (
    // A data attribute rather than a `record-${metric}` class: a templated class name leaves a
    // bare `record-` that no stylesheet defines, which css-classes.test.ts is right to refuse,
    // and every class in this app stays greppable as written.
    <li className="record-row" data-metric={record.metric}>
      <span className="record-metric">{t(`records.metric.${record.metric}`)}</span>
      <span className="record-value">{recordValue(record.metric, record.value, language, t)}</span>
      <span className="record-date">{onDate(record.localDate, language)}</span>
      {/* Named only when one device can be. A merged day assembled from two watches belongs to
          neither, and a provider row carries no mix at all, so most of the time this says nothing
          rather than "unknown" - a row that says "unknown" reads as a fault.
          Rendered empty rather than omitted, though: these rows are columns now, and an omitted
          cell reserves no width, so the window line on the two metrics with no single device used
          to slide left past every other row's. Saying nothing and occupying nothing are different
          things, and only the first one was ever intended. */}
      <span className="record-source">
        {record.sourceName === null ? '' : sourceLabel({ name: record.sourceName, defaultName: record.sourceDefaultName }, t, language, today)}
      </span>
      {/* The metric's own history, which is not the page's: floors and total_calories reach
          back further than steps do on a real archive, and a record means less without knowing
          how many days it beat. */}
      <span className="record-window">
        {t('records.bests.outOf', { days: record.days, from: onDate(record.from, language) })}
      </span>
    </li>
  )
}

/**
 * A session record's value, in the unit its category reads it in, through the workout page's own
 * formatter for each (formatFigureValue): a duration for the longest ("4h 24m", "4u 24m"), a
 * distance in kilometres (a swim's in whole metres), a climb in whole metres, and a fastest time
 * as its stopwatch followed by the category's rate over that distance: a pace a kilometre on foot,
 * a speed on a bike ("km/u" in Dutch). A run's kilometre is its pace alone, as it always read.
 */
function sessionValue(record: SessionRecord, language: string, t: Translate): string {
  const value = (metric: string, unit: string, v: number) => formatFigureValue(valueAs(metric, unit), v, language, t)
  if (record.kind === 'longest') return value('longest', 'minutes', record.value / 60_000)
  if (record.kind === 'furthest') {
    return record.category === 'swim' ? swimDistanceText(record.value, language, t) : value('distance', 'meters', record.value)
  }
  if (record.kind === 'most-climb') return value('climb', 'meters', record.value)
  if (record.category === 'run' && record.kind === 'fastest-1k') return value('pace', 'seconds_per_km', record.value)
  const time = value('elapsed', 'seconds', record.value)
  // The distance core reads the effort over, through the shared map.
  const key = record.kind.slice('fastest-'.length)
  const meters = effortDistancesOf(record.category).find((d) => d.key === key)?.meters
  if (meters === undefined || record.value <= 0) return time
  const rate = sessionRateText(record.category, record.value / (meters / 1000), language, t)
  return rate === null ? time : `${time} · ${rate}`
}

/** The record's name, in the category's words where it has its own ("Longest ride", "Langste rit"). */
function sessionRecordName(record: SessionRecord, t: Translate): string {
  if (record.kind === 'longest') return t(`records.sessions.longestOf.${record.category}`)
  if (record.kind === 'furthest') return t(`records.sessions.furthestOf.${record.category}`)
  return t(`records.sessions.${record.kind}`)
}

function SessionRecordRow({ record, t, language }: {
  record: SessionRecord, t: Translate, language: string
}) {
  // Named only when it says more than the card's label does: "Trail run" under Running, never
  // "Running" again. A category with no one plain type names every type.
  const typeText = record.exerciseType === null || record.exerciseType === PLAIN_TYPE[record.category]
    ? '' : exerciseTypeLabel(t, record.exerciseType)
  return (
    // .record-row's layout, shared deliberately with the daily records: the two lists answer the
    // same question at different grains and should not look like two features. `data-record` is
    // the seam a test needs. The whole row opens the workout that set it, as an Activity list row
    // does (workoutPath), rather than a link buried in one cell.
    <li className="record-row record-row-linked" data-record={record.kind} data-category={record.category}>
      <Link to={workoutPath(record.sessionId)} className="record-row-link">
        <span className="record-metric">{sessionRecordName(record, t)}</span>
        <span className="record-value">{sessionValue(record, language, t)}</span>
        <span className="record-date">{onDate(record.localDate, language)}</span>
        {/* Empty rather than omitted when there is nothing to add, for the same reason RecordRow's
            device cell is: these rows are columns, and an omitted cell holds no width. */}
        <span className="record-source">{typeText}</span>
      </Link>
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
