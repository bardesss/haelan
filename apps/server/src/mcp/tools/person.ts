import { z } from 'zod'
import { METRICS } from '@haelan/core/metrics'
import type { Tool } from '../contract.ts'
import { untrusted, UNTRUSTED } from '../contract.ts'

export const describePerson: Tool = {
  name: 'describe_person',
  description:
    'The person this session is bound to: their id, their timezone, and the sources that have '
    + 'reported data for them. Call this first — every other tool answers for this person only, '
    + 'and source ids from here are what the `source` argument of every other tool accepts. The '
    + 'five daily tools additionally accept `merged` and `provider`, which name who reconciled a '
    + 'day rather than a device, and so appear in no list here.',
  notes:
    'There is deliberately no tool that lists the household. A session is bound to one person, and '
    + 'listing the others would name people whose data this session cannot read.',
  inputSchema: {
    // Declared, not taken from a clock: the Tool contract deliberately gives `run` no second
    // argument beyond its parsed input (see contract.ts), so there is nowhere for a server clock
    // to enter. Without this the staleness fields below could never be reached at all.
    today: z.string().optional().describe(
      "Today's date as YYYY-MM-DD. Supply it to learn whether each source is still reporting: "
      + 'without it, lastReportedDate and status come back null. A source that quietly stopped is '
      + 'why a series can thin out without any single day being wrong.',
    ),
  },
  outputSchema: {
    personId: z.string(),
    displayName: UNTRUSTED,
    timezone: z.string(),
    // An enum, not a string: core types `DescribedPerson.sources[].kind` as this exact
    // three-value union, so `z.string()` gave an agent a field it could only learn the values of
    // by seeing them. TOOLS.md renders an enum as its members, which is the document saying what
    // the answer can be rather than that it is text.
    sources: z.array(z.object({
      id: z.string(), name: UNTRUSTED, kind: z.enum(['device', 'app', 'manual']),
      // Not untrusted: a date and an enum this instance computed, unlike the name a device chose
      // for itself. An agent reading a thin series otherwise has no way to learn that the device
      // behind it stopped reporting months ago.
      lastReportedDate: z.string().nullable(),
      status: z.enum(['reporting', 'stale', 'unjudged']).nullable(),
    })),
  },
  run: (q, args) => {
    const today = typeof args['today'] === 'string' ? args['today'] : undefined
    const person = q.describe({ today })
    return {
      personId: person.id,
      displayName: untrusted(person.displayName),
      timezone: person.timezone,
      sources: person.sources.map((s) => ({
        id: s.id, name: untrusted(s.name), kind: s.kind,
        lastReportedDate: s.lastReportedDate, status: s.status,
      })),
    }
  },
}

export const listMetrics: Tool = {
  name: 'list_metrics',
  description:
    'Every metric this instance can answer for, with the aggregates each one allows and the unit '
    + 'it is measured in. Use it before query_series rather than guessing a metric name; a name '
    + 'that is not here is refused rather than answered empty.',
  inputSchema: {},
  outputSchema: {
    metrics: z.array(z.object({
      metric: z.string(),
      aggs: z.array(z.string()),
      unit: z.string(),
      precision: z.number(),
      direction: z.string(),
    })),
  },
  // METRICS is a Record<string, MetricSpec> keyed by metric name, NOT an array, and MetricSpec
  // carries no `name` — the key is the name. `unit` is a required string, never null. Verified
  // against packages/core/src/derive/metrics.ts:30 before this plan was written; check it again
  // rather than trusting this comment.
  run: () => ({
    metrics: Object.entries(METRICS).map(([metric, spec]) => ({
      metric,
      aggs: [...spec.aggs],
      unit: spec.unit,
      precision: spec.precision,
      direction: spec.direction,
    })),
  }),
}

export const personTools: Tool[] = [describePerson, listMetrics]
