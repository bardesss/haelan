import { useTranslation } from '../../i18n/index.js'
import { formatNumber, formatSessionDateHeading, formatWeekdayDate } from '../../format.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { workoutSummary } from '@haelan/core/workout-summary'
import { exerciseTypeLabel } from '../../data/exerciseTypeLabel.js'
import { exerciseCategory } from '@haelan/core/exercise-category'
import type { ExerciseCategory, SessionRate } from '@haelan/core/exercise-category'
import { Icon } from '../../components/icons.js'
import { Link } from '../../router.js'
import { distanceText, sessionRateText } from './categoryText.js'
import { noBreak } from '../detail/figureText.js'
import { workoutPath } from './workout/workoutText.js'

/**
 * Two lines, not a fixed column table: only 97 of 192 real sessions carry a distance and 77 a
 * pace, so a Distance column would be blank for half the list, and this project's convention
 * forbids a blank cell that reads as a recorded zero. The first line is what nearly every session
 * has (type and duration, and calories and heart rate when the device recorded them); the second
 * carries only the fields THIS session has, built as an array and joined so a field the session
 * never recorded is left out of the sentence rather than printed as an empty slot.
 *
 * The date is not on that first line unless `dated` asks for it (the Activity page's list, whose
 * rows span days and print it on the row itself). Otherwise a caller's own heading carries it, and
 * the row still names its own date in the `sr-only` span below, because a screen reader landing on
 * one row by arrow-key browsing has no guarantee it heard the heading first.
 *
 * `session-row` on the root is load bearing beyond this file: the next task's list counts rows
 * with `container.querySelectorAll('.session-row')`, so it has to be there even though nothing in
 * this file's own tests reads it back.
 *
 * Every field is tested with `!== null`, never truthiness: workoutSummary already turns an
 * unrecorded field into null and a recorded zero into 0, and a `value ? ... : null` guard here
 * would undo that distinction right before it reaches a reader, which is the one thing this
 * component exists to not do.
 */
/**
 * What sits between two figures on a row.
 *
 * A middot rather than a hyphen, and it is not decoration: "445 kcal - 151 bpm" puts a minus sign
 * between two numbers, so the eye reads an arithmetic relation that does not exist before it reads
 * a list. Both lines of this row are lists of unrelated measurements, which is exactly the case a
 * hyphen is wrong for.
 *
 * Not translated. It is punctuation rather than copy, and no locale this app ships spells a list
 * separator differently.
 */
const SEPARATOR = ' · '

/** The glyph each category draws. Named here so icons.tsx stays a set of drawings. */
export const CATEGORY_ICONS: Record<ExerciseCategory, string> = {
  run: 'sessionRun',
  walk: 'sessionWalk',
  ride: 'sessionRide',
  swim: 'sessionSwim',
  strength: 'sessionStrength',
  cardio: 'sessionCardio',
  other: 'sessionOther',
}

export interface SessionRowViewProps {
  id: string
  type: string | null
  startMs: number
  durationSeconds: number | null
  distanceMeters: number | null
  caloriesKcal: number | null
  averageHeartRateBpm: number | null
  excluded: boolean
  excludeReason?: string | null
  /** The person's own day for the row, the same one a caller's date heading groups by. */
  localDate: string
  /** The session's rate as core sends it (sessions.ts's sessionRateOf); absent from an older payload. */
  rate?: SessionRate | null
  elevationGainMeters?: number | null
  /** The date at the head of the second line ("Wed, Sep 30 · 8.7 km"), for a list with no date
   *  headings of its own (the Activity overview's workouts, the approved mockup's). */
  dated?: boolean
}

/** The row, from flat props, for callers that hold a summary and not a merged session. */
export function SessionRowView(props: SessionRowViewProps) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { distanceMeters, caloriesKcal, averageHeartRateBpm } = props
  const rate = props.rate ?? null
  const elevationGainMeters = props.elevationGainMeters ?? null
  const excludeReason = props.excludeReason ?? null
  const { localDate } = props

  // The same call a caller's date heading makes for a session's group, reused here rather
  // than reformatted, so the sr-only date below can never read a different day than the heading
  // a sighted reader sees above it.
  const dateHeading = formatSessionDateHeading(localDate, language)
  const typeText = exerciseTypeLabel(t, props.type)
  const category = exerciseCategory(props.type)
  // Not read off metricsSummary: every session has a start and an end, so a duration derived from
  // them is never one of the fields this row has to omit.
  const durationMinutes = props.durationSeconds === null ? null : Math.round(props.durationSeconds / 60)
  const durationText = durationMinutes === null ? null
    : noBreak(`${formatNumber(durationMinutes, 0, language, '0')} ${t('activity.units.min')}`)

  const stats = [
    caloriesKcal === null ? null
      : noBreak(`${formatNumber(caloriesKcal, 0, language, '')} ${t('activity.units.kcalShort')}`),
    averageHeartRateBpm === null ? null
      : noBreak(`${formatNumber(averageHeartRateBpm, 0, language, '')} ${t('activity.units.bpm')}`),
  ].filter((part): part is string => part !== null)

  // Distance, the category's rate and elevation gain only. workoutSummary also carries steps and
  // activeZoneMinutes, but activeZoneMinutes alone covers 167 of 192 sessions, which would make
  // this line a routine five figures on the common case rather than the one to three the two line
  // design was scoped for. Steps on a run restates distance and active zone minutes restates the
  // heart rate already on the first line, so leaving both off keeps this line reserved for what a
  // reader actually came to a workout row to see (fix round 1 review).
  const detail = [
    props.dated === true ? formatWeekdayDate(localDate, language) : null,
    // As Records and the per-type totals beside the Activity list print a distance (distanceText).
    distanceMeters === null ? null : distanceText(category, distanceMeters, language, t),
    // The rate the category reads (a ride's speed, a swim's time per 100 m), as the server picked
    // it by the workout page's rules; nothing where it sends none.
    sessionRateText(rate, language, t),
    elevationGainMeters === null ? null
      : noBreak(`${formatNumber(elevationGainMeters, 0, language, '')} ${t('activity.units.elevationGainShort')}`),
  ].filter((part): part is string => part !== null)

  // Struck through and kept, not filtered out: the Activity count above this list already drops
  // an excluded workout at derivation, and the two visibly disagreeing (fewer counted than listed,
  // one struck through) is what lets a reader see what they threw out, rather than wondering why a
  // session they remember is simply gone.
  const rowClassName = props.excluded ? 'session-row session-row-excluded' : 'session-row'

  return (
    // The row's own way into WorkoutDetail (M8b): the whole row is the target, not a link buried
    // inside it, so this wraps the existing body unchanged rather than adding a link somewhere
    // within it.
    <Link to={workoutPath(props.id)} className="session-row-link">
      <div className={rowClassName}>
        <div className="session-row-main">
          {/* A glyph per category, never per type: the catalogue declares 182 exercise types and a
              real archive holds about a dozen, so an icon each would be drawings nobody sees. The
              fallback is a real mark rather than nothing, so no row is the one that looks
              unfinished - which is what an omitted cell did to the Records device column. */}
          <span className="session-row-icon" data-category={category}>
            <Icon name={CATEGORY_ICONS[category]} />
          </span>
          <span className="session-row-primary">
            {/* Trailing space: this text node sits directly against session-row-type's own text
                node with nothing between them in the accessibility tree, and without it a screen
                reader concatenates the two into one word ("augustusCardiotraining"). */}
            <span className="sr-only">{`${dateHeading} `}</span>
            <span className="session-row-type">{typeText}</span>
            {durationText !== null && <span className="session-row-duration">{durationText}</span>}
          </span>
          {stats.length > 0 && <span className="session-row-stats">{stats.join(SEPARATOR)}</span>}
          {/* The row has linked to the workout page since M8b with nothing at rest to say so - a
              hover background was the only hint, which a finger never sees. Decoration rather than
              content: it repeats what the link already means, so it is hidden from a screen reader
              instead of being read out as a separate thing. */}
          <span className="session-row-go" aria-hidden="true"><Icon name="chevronRight" /></span>
        </div>
        {/* Omitted outright, not rendered empty: the fourth test pins a session with none of these
            fields to one line, and an empty div here would still be a second line, just a blank one. */}
        {detail.length > 0 && <div className="session-row-detail">{detail.join(SEPARATOR)}</div>}
        {/* excludeReason can be null even when excluded is true (a person can exclude without
            typing a reason), so this falls back to a bare "Excluded" rather than printing "Excluded:
            " with nothing after the colon. */}
        {props.excluded && (
          <div className="session-row-excluded-reason">
            {excludeReason !== null
              ? t('activity.sessions.excluded', { reason: excludeReason })
              : t('activity.sessions.excludedNoReason')}
          </div>
        )}
      </div>
    </Link>
  )
}

/** A workout session as it reaches the row today: the merged session, read through workoutSummary. */
export function SessionRow({ session }: { session: WorkoutSession }) {
  const summary = workoutSummary(session.attrs)
  return (
    <SessionRowView
      id={session.id}
      type={summary.exerciseType}
      startMs={session.startMs}
      durationSeconds={(session.endMs - session.startMs) / 1000}
      distanceMeters={summary.distanceMeters}
      caloriesKcal={summary.caloriesKcal}
      averageHeartRateBpm={summary.averageHeartRateBpm}
      excluded={session.excluded}
      excludeReason={session.excludeReason}
      rate={session.rate ?? null}
      elevationGainMeters={summary.elevationGainMeters}
      localDate={session.localDate}
    />
  )
}
