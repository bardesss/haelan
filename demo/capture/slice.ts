// The demo's days (M9c): the dashboard steps through the days of a five-week window, so the
// capture records a past day's glance for each of them and the calendar months they fall in. The
// seeded archive reaches much further back than that, and the server answers as it should for the
// archive it has: the earliest captured day's back arrow points at a day before the window, the
// calendar's `firstDay` is the archive's first day and its months list days nobody captured, and a
// strip's dots on the window's first days sit on days before it. Each of those would open a day the
// demo has no answer for.
//
// Trimmed here, after the sweep, rather than bounded in the capture server: a bound there would have
// to reach core's `nearestDayWithData`, the route's validation and the calendar reader, three places
// whose only reason to change would be the demo, while the captured JSON is the demo's own and is
// already the only thing it replays. The rewrite says what the demo's slice is (an archive that
// begins on its first captured day), and a real instance whose archive began that day answers the
// same nav and calendar.
//
// The strips are the one place that is not simply the server's answer with a bound applied: a day
// before the first day keeps its value on a real instance, and its dot would open that day. Emptied
// here instead, so the dot is never drawn and so never offered, which is what the calendar already
// says of those days (greyed, no data). Each emptied day's own band goes with it, so the strip's
// per-day band shades nothing before the first day either: a usual over days the demo does not
// have is no more its to show than their values are. The figures themselves (each day's own value, its band, its
// verdict) are the capture's, untouched. The week card's averages are recounted over what is left,
// with core's own weekOf rules and the server's own rounding, so a week of three bars never claims
// seven days. The recount starts from the strip's rounded daily values where the server averaged
// the raw ones, so on the window's first six days (the only ones whose strips reach before it) the
// asleep average can differ from what a real instance would show by up to a minute.
import { weekOf, weekOfFinished } from '../../packages/core/src/query/glance.ts'
import type { Glance, GlanceStripDay, GlanceWeekFigure } from '../../packages/core/src/query/glance.ts'
import { roundMetricValue } from '../../apps/server/src/routes/v1/shared.ts'

const GLANCE = /^\/api\/v1\/p\/[^/]+\/glance$/
const CALENDAR = /^\/api\/v1\/p\/[^/]+\/glance\/calendar$/

interface CalendarBody { month: string, firstDay: string | null, days: { localDate: string }[] }

/** Empties every strip day before `firstDay` (value, band and verdict), anywhere in the glance. Answers the strips where a day had a value. */
function emptyStripsBefore(node: unknown, firstDay: string): Set<GlanceStripDay[]> {
  const changed = new Set<GlanceStripDay[]>()
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(walk); return }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'strip' && Array.isArray(child)) {
        const strip = child as GlanceStripDay[]
        for (const day of strip) {
          if (day.localDate >= firstDay) continue
          day.band = null
          if (day.value === null) continue
          day.value = null
          day.standing = null
          changed.add(strip)
        }
      } else {
        walk(child)
      }
    }
  }
  walk(node)
  return changed
}

function roundWeek(metric: string, figure: GlanceWeekFigure | null): GlanceWeekFigure | null {
  return figure === null ? null : {
    ...figure, perDay: roundMetricValue(metric, figure.perDay), total: roundMetricValue(metric, figure.total),
  }
}

/** A captured glance as the demo's slice has it: nothing before `firstDay` to open. A copy. */
export function trimGlance(captured: Glance, firstDay: string): Glance {
  const glance = structuredClone(captured)
  const changed = emptyStripsBefore(glance, firstDay)
  // readGlance's own choice between the two: a finished day's own strip day is a whole day.
  const days = glance.finished ? weekOfFinished : weekOf
  if (changed.has(glance.day.steps.strip)) glance.week.steps = roundWeek('steps', days(glance.day.steps.strip))
  if (changed.has(glance.day.activeMinutes.strip)) {
    glance.week.activeMinutes = roundWeek('active_minutes_light', days(glance.day.activeMinutes.strip))
  }
  // Without a night the week's asleep figure came from a strip the payload does not carry, and the
  // week card draws no asleep row then (WeekCard.tsx), so there is nothing on screen to recount.
  if (glance.sleep !== null && changed.has(glance.sleep.asleep.strip)) {
    glance.week.asleep = roundWeek('sleep_asleep_minutes', weekOfFinished(glance.sleep.asleep.strip))
  }
  if (glance.nav.previous !== null && glance.nav.previous < firstDay) glance.nav = { ...glance.nav, previous: null }
  return glance
}

/**
 * Rewrites the captured glances and calendars in place so the demo's archive begins on `firstDay`:
 * no glance steps back past it or offers a dot before it, every calendar names it as the first day
 * and lists no day before it, and a calendar month wholly before it is dropped, since the calendar
 * never pages back past the first day's own month.
 */
export function sliceToFirstDay(recorded: Map<string, unknown>, firstDay: string): void {
  for (const [url, body] of [...recorded]) {
    const [path = '', search = ''] = url.split('?')
    if (GLANCE.test(path)) {
      recorded.set(url, trimGlance(body as Glance, firstDay))
    } else if (CALENDAR.test(path)) {
      const month = new URLSearchParams(search).get('month')
      if (month !== null && month < firstDay.slice(0, 7)) {
        recorded.delete(url)
        continue
      }
      const calendar = body as CalendarBody
      recorded.set(url, { ...calendar, firstDay, days: calendar.days.filter((day) => day.localDate >= firstDay) })
    }
  }
}

/**
 * Every day the dashboard can open from a captured response that has no captured glance to open:
 * the arrows (`nav`), a strip's dots and a week bar (every strip day with a value, bar the day
 * shown), and the calendar's days. `today` opens the plain `/glance` (useDashboardDay drops a
 * `?day=` naming today). Empty when the demo can answer every one.
 *
 * The strip walk mirrors the app's openers rather than calling them: `useOpensDay` (a strip's
 * dots) and `WeekBars.opens` (a week bar) both read a card's `strip` array and open any day on it
 * with a value other than the one shown. Should either start opening from something else, this has
 * to follow, or it will pass while the demo misses.
 */
export function unreachableDays(recorded: ReadonlyMap<string, unknown>, today: string): string[] {
  const glanceDays = new Set<string>()
  const opened = new Map<string, string>()
  const note = (day: string, from: string) => { if (!opened.has(day)) opened.set(day, from) }
  for (const [url, body] of recorded) {
    const [path = '', search = ''] = url.split('?')
    if (GLANCE.test(path)) {
      const glance = body as Glance
      glanceDays.add(new URLSearchParams(search).get('day') ?? today)
      for (const day of [glance.nav.previous, glance.nav.next]) if (day !== null) note(day, url)
      const walk = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return
        if (Array.isArray(value)) { value.forEach(walk); return }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (key === 'strip' && Array.isArray(child)) {
            for (const day of child as GlanceStripDay[]) {
              if (day.value !== null && day.localDate !== glance.today) note(day.localDate, url)
            }
          } else {
            walk(child)
          }
        }
      }
      walk(glance)
    } else if (CALENDAR.test(path)) {
      for (const day of (body as CalendarBody).days) if (day.localDate <= today) note(day.localDate, url)
    }
  }
  return [...opened].filter(([day]) => !glanceDays.has(day)).map(([day, from]) => `${day} (from ${from})`).sort()
}

/**
 * Every workout a captured glance lists (`day.workouts`, each row a link to its own page) whose
 * page the demo cannot open: no recorded `/sessions/:id`, the one read WorkoutDetail makes for it
 * (useWorkoutSession's sessionPath, the same encoding). Empty when every row has its page.
 */
export function unreachableWorkouts(recorded: ReadonlyMap<string, unknown>): string[] {
  const missing = new Set<string>()
  for (const [url, body] of recorded) {
    const [path = ''] = url.split('?')
    if (!GLANCE.test(path)) continue
    const base = path.slice(0, -'/glance'.length)
    for (const { id } of (body as Glance).day.workouts) {
      if (!recorded.has(`${base}/sessions/${encodeURIComponent(id)}`)) missing.add(`${id} (from ${url})`)
    }
  }
  return [...missing].sort()
}
