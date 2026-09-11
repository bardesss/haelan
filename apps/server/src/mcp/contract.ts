import type { z } from 'zod'
import type { PersonQuery } from '@haelan/core'

/**
 * One tool, with no MCP types in it.
 *
 * The adapters — the stdio entry today, `POST /mcp` in M4a-3 — are what know about the protocol.
 * A tool is a description, two shapes and a function, which is why a second transport costs an
 * adapter rather than a second catalogue.
 *
 * `run` takes a PersonQuery and nothing else. Not a convention: NoteStore and EventStore take a
 * person id as a plain argument, so a tool body holding one could name any member of the
 * household. This signature makes that unrepresentable.
 */
export interface Tool<I extends z.ZodRawShape = z.ZodRawShape, O extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  /** Written for the agent. Human-only prose goes in `notes`, which only TOOLS.md renders. */
  description: string
  notes?: string
  inputSchema: I
  outputSchema: O
  run: (q: PersonQuery, args: z.infer<z.ZodObject<I>>) => z.infer<z.ZodObject<O>>
}

/**
 * Budgets are the server's to set, not the caller's to request.
 *
 * A browser knows its own pixel width; an agent does not know its own context window, and a model
 * asked to pick a number will pick one that sounds generous. `MAX_POINTS` therefore binds
 * regardless of what was asked for.
 */
export const DEFAULT_DAILY_POINTS = 200
export const DEFAULT_INTRADAY_POINTS = 300
export const MAX_POINTS = 1000

export function budgetFor(asked: number | undefined, fallback: number): number {
  if (asked === undefined) return fallback
  return Math.min(Math.max(1, Math.floor(asked)), MAX_POINTS)
}

export interface Summary {
  n: number
  min: number | null
  max: number | null
  mean: number | null
  median: number | null
  first: number | null
  last: number | null
}

/**
 * Returned alongside every series, because a thinned series without them is a shape with no scale.
 * An agent that can see n, min, max and the median can tell a flat line from a downsampled one.
 */
export function summaryOf(values: readonly number[]): Summary {
  if (values.length === 0) {
    return { n: 0, min: null, max: null, mean: null, median: null, first: null, last: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return {
    n: values.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean: values.reduce((t, v) => t + v, 0) / values.length,
    median: sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    first: values[0]!,
    last: values.at(-1)!,
  }
}

export const MAX_TEXT = 2000

export interface Untrusted {
  untrustedText: string | null
  truncated: boolean
}

/**
 * Free text written by a person or a device, in a field whose name says so.
 *
 * Four sources reach an agent this way: a note's body, an event's note, a source's display name or
 * alias, and a workout's own name or notes — the last two straight from the provider's payload.
 * None of it is an instruction, and the tool descriptions say so. The rule that makes this
 * mechanical rather than stylistic lives at the adapters: the human-readable text block is
 * composed only from values this app generated, so no string from here ever reaches the prose an
 * agent reads first.
 */
export function untrusted(text: string | null | undefined, max = MAX_TEXT): Untrusted {
  if (text === null || text === undefined) return { untrustedText: null, truncated: false }
  if (text.length <= max) return { untrustedText: text, truncated: false }
  return { untrustedText: text.slice(0, max), truncated: true }
}
