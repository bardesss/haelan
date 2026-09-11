import { z } from 'zod'
import type { Tool } from '../contract.ts'
import { budgetFor, defineTool, summaryOf, DEFAULT_INTRADAY_POINTS, REDUCTION, SUMMARY } from '../contract.ts'

export const getIntraday = defineTool({
  name: 'get_intraday',
  description:
    'Per-minute samples for a metric on one local date — heart rate, spo2, hrv and the like. Takes '
    + 'exactly one local date, because that is what this reads; ask query_series for a coarser view '
    + 'over a wider range instead. Returns at most a few hundred points: a busy day is downsampled '
    + 'and `reduction` says so, so read `summary` for the true extremes rather than assuming the '
    + 'points are every minute.',
  inputSchema: {
    metric: z.string(),
    localDate: z.string().describe('YYYY-MM-DD'),
    points: z.number().optional(),
    sourceId: z.string().optional(),
  },
  outputSchema: {
    points: z.array(z.object({
      sourceId: z.string(),
      utcMs: z.number(),
      min: z.number().nullable(),
      mean: z.number().nullable(),
      max: z.number().nullable(),
      n: z.number(),
      excluded: z.boolean(),
    })),
    reduction: REDUCTION,
    summary: SUMMARY,
  },
  run: (q, args) => {
    const result = q.intraday({
      metric: args.metric, localDate: args.localDate,
      points: budgetFor(args.points, DEFAULT_INTRADAY_POINTS), sourceId: args.sourceId,
    })
    return {
      points: result.points.map((p) => ({
        sourceId: p.sourceId, utcMs: p.utcMs, min: p.min, mean: p.mean, max: p.max,
        n: p.n, excluded: p.excluded,
      })),
      reduction: result.reduction,
      summary: summaryOf(result.points.map((p) => p.mean).filter((v) => v !== null)),
    }
  },
})

export const getSleep = defineTool({
  name: 'get_sleep',
  description:
    'Sleep nights in a local date range, one entry per night per source, with their stage segments '
    + 'and any naps that did not join the night. A night that crosses midnight is filed under the '
    + 'morning it ends on, not the evening it started — asking for "last night" against the date it '
    + 'began on gets an honest empty answer with nothing here to explain it, so use the date the '
    + 'person woke up.',
  inputSchema: {
    from: z.string().describe('YYYY-MM-DD, inclusive'),
    to: z.string().describe('YYYY-MM-DD, inclusive'),
    sourceId: z.string().optional(),
  },
  outputSchema: {
    nights: z.array(z.object({
      localDate: z.string(),
      sourceId: z.string(),
      sessionIds: z.array(z.string()),
      startMs: z.number(),
      endMs: z.number(),
      startOffsetMinutes: z.number(),
      endOffsetMinutes: z.number(),
      naps: z.array(z.number()),
      segments: z.array(z.object({
        stage: z.string(), startMs: z.number(), endMs: z.number(),
      })),
      excludedSessions: z.array(z.string()),
    })),
  },
  run: (q, args) => ({
    nights: q.sleepNights({ from: args.from, to: args.to, sourceId: args.sourceId }),
  }),
})

export const intradayTools: Tool[] = [getIntraday, getSleep]
