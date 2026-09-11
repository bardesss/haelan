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
  inputSchema: {},
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
    })),
  },
  run: (q) => {
    const person = q.describe()
    return {
      personId: person.id,
      displayName: untrusted(person.displayName),
      timezone: person.timezone,
      sources: person.sources.map((s) => ({ id: s.id, name: untrusted(s.name), kind: s.kind })),
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
