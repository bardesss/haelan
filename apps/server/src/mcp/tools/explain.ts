import { z } from 'zod'
import { metricSpec } from '@haelan/core/metrics'
import { ConfigError } from '@haelan/core'
import type { Tool } from '../contract.ts'
import { defineTool } from '../contract.ts'
import { DAILY_SOURCE, defaultAggFor } from './series.ts'
import { EMPTY_EVIDENCE, EMPTY_LINKS, walkEmpty } from './explainEmpty.ts'
import { RECOVERY_EVIDENCE, RECOVERY_LINKS, walkRecovery } from './explainRecovery.ts'

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

const LINKS = [...EMPTY_LINKS, ...RECOVERY_LINKS] as const

export const explainTool = defineTool({
  name: 'explain',
  description:
    'Walks one chain for a question and stops at the first link that accounts for it, so an agent '
    + 'does not have to stitch the other tools together and keep looking after the first sufficient '
    + 'answer. `stoppedAt` names the link that answered and `walked` every link checked on the way, '
    + 'so there is nothing further to walk. `finding` is one sentence about the data - an '
    + 'association with how the day was lived at most, never a cause, advice, a readiness verdict '
    + 'or a claim about the person\'s health - and `evidence` carries the numbers behind it, under '
    + 'the kind asked; a field a link never reached is null.\n\n'
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
    + 'is distance from this person\'s own normal, not a readiness verdict. `metric`, `agg` and '
    + '`source` are refused for this kind.',
  inputSchema: {
    kind: z.enum(['empty', 'recovery']),
    localDate: z.string().describe('YYYY-MM-DD'),
    metric: z.string().optional().describe('Required for `empty`, refused for `recovery`.'),
    agg: z.string().optional().describe(
      '`empty` only. Omitted, the metric\'s own default aggregate, the one get_daily uses.',
    ),
    source: DAILY_SOURCE,
  },
  outputSchema: {
    kind: z.enum(['empty', 'recovery']),
    finding: z.string(),
    stoppedAt: z.enum(LINKS),
    walked: z.array(z.enum(LINKS)),
    evidence: z.object({
      empty: EMPTY_EVIDENCE.nullable(),
      recovery: RECOVERY_EVIDENCE.nullable(),
    }),
  },
  run: (q, args) => {
    if (args.kind === 'recovery') {
      // Refused rather than ignored: the index is always the day's own all-sources number, and a
      // `source` that silently changed nothing would read as an answer about that source.
      for (const name of ['metric', 'agg', 'source'] as const) {
        if (args[name] !== undefined) throw new ConfigError(`kind 'recovery' takes no ${name}: the recovery index is the day's own number`)
      }
      const { evidence, ...rest } = walkRecovery(q, args.localDate)
      return { kind: args.kind, ...rest, evidence: { empty: null, recovery: evidence } }
    }

    if (args.metric === undefined) throw new ConfigError('kind \'empty\' needs a metric')
    const spec = metricSpec(args.metric)
    // An unknown metric is refused by series()'s own requireMetricAndAgg on the first read, the
    // same way get_daily lets it be, so the empty agg below never reaches an answer.
    const agg = args.agg ?? (spec === undefined ? '' : defaultAggFor(spec))
    const { evidence, ...rest } = walkEmpty(q, { metric: args.metric, agg, localDate: args.localDate, source: args.source })
    return { kind: args.kind, ...rest, evidence: { empty: evidence, recovery: null } }
  },
})

export const explainTools: Tool[] = [explainTool]
