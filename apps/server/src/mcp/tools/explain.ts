import { z } from 'zod'
import { metricSpec } from '@haelan/core/metrics'
import { ConfigError } from '@haelan/core'
import type { Tool } from '../contract.ts'
import { defineTool } from '../contract.ts'
import { DAILY_SOURCE, defaultAggFor } from './series.ts'
import { EMPTY_EVIDENCE, EMPTY_LINKS, walkEmpty } from './explainEmpty.ts'
import { RECOVERY_EVIDENCE, RECOVERY_LINKS, walkRecovery } from './explainRecovery.ts'
import { WORKOUT_EVIDENCE, WORKOUT_LINKS, walkWorkout } from './explainWorkout.ts'
import { DAY_EVIDENCE, DAY_LINKS, walkDay } from './explainDay.ts'

/**
 * `explain` (issue 412): one chain per kind, walked in order, that stops at the first link
 * accounting for the question. The agent this is for otherwise stitches five tools together and
 * keeps fishing after the first sufficient account; here the walk is done once, and `walked` says
 * how far it went. Each kind's chain lives in its own file.
 *
 * `evidence` holds one object per kind, the asked kind's filled in and every other null, for the
 * reason recovery.ts gives for a flat shape: TOOLS.md's generator documents a plain object's
 * fields and renders a union as an opaque type. Link names are unique across kinds, so one enum
 * serves `stoppedAt` and `walked` for all of them.
 */

const LINKS = [...EMPTY_LINKS, ...RECOVERY_LINKS, ...WORKOUT_LINKS, ...DAY_LINKS] as const

type Kind = 'empty' | 'recovery' | 'workout' | 'day'
type Argument = 'localDate' | 'today' | 'sessionId' | 'metric' | 'agg' | 'source'

// Which arguments each kind reads. Anything else is refused rather than ignored: an argument that
// silently changed nothing would read as an answer about it - a `source` on the recovery index,
// which is always the day's own all-sources number, or a date on a workout, which has its own.
const TAKES: Readonly<Record<Kind, { needs: readonly Argument[], may: readonly Argument[] }>> = {
  empty: { needs: ['localDate', 'metric'], may: ['agg', 'source'] },
  recovery: { needs: ['localDate'], may: [] },
  workout: { needs: ['sessionId'], may: [] },
  day: { needs: ['localDate', 'today'], may: [] },
}

function requireArguments(kind: Kind, args: Partial<Record<Argument, string>>): void {
  const { needs, may } = TAKES[kind]
  for (const name of needs) if (args[name] === undefined) throw new ConfigError(`kind '${kind}' needs ${name}`)
  for (const name of Object.keys(args) as Argument[]) {
    if (args[name] !== undefined && !needs.includes(name) && !may.includes(name)) {
      throw new ConfigError(`kind '${kind}' takes no ${name}`)
    }
  }
}

export const explainTool = defineTool({
  name: 'explain',
  description:
    'Walks one chain for a question and stops at the first link that accounts for it, so an agent '
    + 'does not have to stitch the other tools together and keep looking after the first sufficient '
    + 'answer. `stoppedAt` names the link that answered and `walked` every link checked on the way, '
    + 'so there is nothing further to walk. `finding` is one sentence about the data - an '
    + 'association with how the day was lived at most, never a cause, advice, a readiness verdict, '
    + 'a suggestion for a next session or a claim about the person\'s health - and `evidence` '
    + 'carries the numbers behind it, under the kind asked; a field a link never reached is null. '
    + 'An argument the kind does not read is refused rather than ignored.\n\n'
    + '`kind: empty` asks why `metric` has no reading on `localDate`. The links, in order: a reading '
    + 'is there after all (`thinBaseline` when its baseline is too thin to judge it against, '
    + '`present` otherwise); the metric was excluded by hand that day; a sleep session that would '
    + 'have been that day\'s night was excluded; the night is filed under the next morning, the one '
    + 'it ended on; the `source` asked for has no row but the day does; nothing has ever reported '
    + 'the metric; the day is before its first reading; the day is after its last; no headline '
    + 'reading arrived that day at all; and last, other readings arrived but this one did not. A '
    + 'thin baseline is low confidence, not evidence of nothing, and a `filled` reading is an '
    + 'intraday average, not a measurement - say so in words.\n\n'
    + '`kind: recovery` asks what the recovery index on `localDate` stands on - the same number '
    + 'recovery_index answers. The links, in order: `withheld`, a day that could not be scored, '
    + 'which is not a low score; `hrvFilledToday`, the day\'s own HRV is an intraday average, so the '
    + 'score is not a measurement throughout; `usual`, the score sits within this person\'s own '
    + 'normal; and `carriedBy`, the input that moved the score furthest in its own direction, with '
    + 'any that pulled the other way. An input\'s points are its share of the distance from 50 and '
    + 'do not add up to it when the inputs disagreed. An absent input, sleep on half its evidence '
    + 'and filled HRV inside the baseline are stated in the finding whichever link answers. `band` '
    + 'is distance from this person\'s own normal, not a readiness verdict.\n\n'
    + '`kind: workout` asks what stands out about the exercise session `sessionId` (from '
    + 'get_workouts) against this person\'s earlier sessions of its type - the same usual ranges the '
    + 'app\'s workout page draws, from up to twenty sessions in the 90 days before it. The links, in '
    + 'order: `excluded`, a session excluded by hand is not judged; `thinHistory`, too few earlier '
    + 'sessions for a usual, or no type at all; `hero`, the figure the page leads with (pace on '
    + 'foot, speed on a bike, time otherwise) outside its usual; `hardMinutes`, the minutes in the '
    + 'vigorous and peak zones outside theirs; `lastKilometre`, the last full kilometre against the '
    + 'session\'s own earlier kilometres; `otherFigure`, any other figure outside its usual; and '
    + '`withinUsual`. These are facts about the session, never about a next one.\n\n'
    + '`kind: day` asks what on the finished day `localDate` sits away from this person\'s own usual, '
    + 'and what was lived beside it - the same readings and 60-day usual ranges the app\'s dashboard '
    + 'draws for that day. It needs `today`, which must be after `localDate`: a day still running is '
    + 'not judged against whole days. The gates come first and stop the walk, because the data '
    + 'cannot carry an interpretation of such a day: `dayEmpty`, nothing arrived; `sourceStopped`, a '
    + 'source feeding the day had stopped before it, judged as of the day itself; `hrvFilled`, the day\'s own HRV is an intraday '
    + 'average; `thinBaselines`, no reading has enough history to judge; then `nothingAway`, every '
    + 'reading sits within its usual. Otherwise the first reading away from its usual, looked for in '
    + 'a fixed order (resting heart rate, HRV, breathing rate, sleep, steps, active minutes), is '
    + 'reported beside the first lived factor away from its own usual, in a fixed order per reading: '
    + '`shortNight`, `lateBedtime` and `heavyYesterday` (the day before\'s vigorous minutes) for a '
    + 'body reading on its worse side, `lateBedtime` for a short night, `workoutThatDay` for more '
    + 'movement, and `loggedEvent` for every reading; `noLivedFactor` when none was. A lived factor '
    + 'is an association reported beside the reading, never the reason for it, and the finding says '
    + 'so.',
  inputSchema: {
    kind: z.enum(['empty', 'recovery', 'workout', 'day']),
    localDate: z.string().optional().describe('YYYY-MM-DD. Required for `empty`, `recovery` and `day`, refused for `workout`.'),
    today: z.string().optional().describe(
      'YYYY-MM-DD, today in the person\'s own zone. Required for `day`, refused otherwise: a day is only '
      + 'explained once it is over.',
    ),
    sessionId: z.string().optional().describe('An exercise session id from get_workouts. Required for `workout`, refused otherwise.'),
    metric: z.string().optional().describe('Required for `empty`, refused otherwise.'),
    agg: z.string().optional().describe(
      '`empty` only. Omitted, the metric\'s own default aggregate, the one get_daily uses.',
    ),
    source: DAILY_SOURCE,
  },
  outputSchema: {
    kind: z.enum(['empty', 'recovery', 'workout', 'day']),
    finding: z.string(),
    stoppedAt: z.enum(LINKS),
    walked: z.array(z.enum(LINKS)),
    evidence: z.object({
      empty: EMPTY_EVIDENCE.nullable(),
      recovery: RECOVERY_EVIDENCE.nullable(),
      workout: WORKOUT_EVIDENCE.nullable(),
      day: DAY_EVIDENCE.nullable(),
    }),
  },
  run: (q, args) => {
    const { kind, ...rest } = args
    requireArguments(kind, rest)
    const none = { empty: null, recovery: null, workout: null, day: null }

    if (kind === 'recovery') {
      const { evidence, ...walk } = walkRecovery(q, args.localDate!)
      return { kind, ...walk, evidence: { ...none, recovery: evidence } }
    }
    if (kind === 'day') {
      const { evidence, ...walk } = walkDay(q, args.localDate!, args.today!)
      return { kind, ...walk, evidence: { ...none, day: evidence } }
    }
    if (kind === 'workout') {
      const { evidence, ...walk } = walkWorkout(q, args.sessionId!)
      return { kind, ...walk, evidence: { ...none, workout: evidence } }
    }

    const metric = args.metric!
    const spec = metricSpec(metric)
    // An unknown metric is refused by series()'s own requireMetricAndAgg on the first read, the
    // same way get_daily lets it be, so the empty agg below never reaches an answer.
    const agg = args.agg ?? (spec === undefined ? '' : defaultAggFor(spec))
    const { evidence, ...walk } = walkEmpty(q, { metric, agg, localDate: args.localDate!, source: args.source })
    return { kind, ...walk, evidence: { ...none, empty: evidence } }
  },
})

export const explainTools: Tool[] = [explainTool]
