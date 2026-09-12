import { z } from 'zod'
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
  // Method shorthand, deliberately, not an arrow-typed property (`run: (q, args) => ...`). The
  // catalogue is a `Tool[]` holding many `Tool<I, O>` instances with different, unrelated I/O, and
  // TypeScript checks an arrow-typed property's parameters contravariantly: a `run` narrower than
  // the array's own default `I`/`O` (which every tool with a real input schema is) then fails to
  // collapse into that one array at all without a cast through `unknown` — a cast that would just
  // as happily hide a `run` some later tool widened to take a second, non-`PersonQuery` argument,
  // which is exactly what this signature exists to make unrepresentable. Method shorthand is
  // checked bivariantly instead, which is the looseness a heterogeneous registry like this one
  // needs, and it is TypeScript's own idiomatic answer to this shape rather than a workaround.
  // Do not "tidy" this back into an arrow-typed property: every tool file breaks at once.
  //
  // The return widened to `| Promise<...>` for M4b: `sql_query` runs its SQL on a worker thread,
  // because better-sqlite3 is synchronous and a slow query would otherwise hold the event loop
  // for its whole duration. Every other tool returns a value and satisfies this unchanged; the
  // adapter awaits, so a synchronous tool costs one already-resolved microtask and nothing else.
  run(q: PersonQuery, args: z.infer<z.ZodObject<I>>):
    z.infer<z.ZodObject<O>> | Promise<z.infer<z.ZodObject<O>>>
}

/**
 * The identity function every tool literal is routed through.
 *
 * A plain `: Tool` annotation on an object literal (no type arguments given) instantiates the
 * interface at its own declared defaults, `Tool<z.ZodRawShape, z.ZodRawShape>` — TypeScript does
 * not back-infer `I`/`O` from the initializer for a variable type annotation the way it infers a
 * generic function's type parameters from the arguments of a call. Left that way, `z.infer` over
 * the defaulted `I` has no concrete keys, so every field of `args` inside `run` is `unknown`,
 * caught only by `pnpm typecheck`, never by any test that calls `run` with a plain object literal.
 * Routing each tool through this generic identity function instead gives TypeScript an actual call
 * to infer `I`/`O` from, the same mechanism any other generic function uses, so `run`'s `args` and
 * return value are checked against this tool's own schemas. This is unrelated to why `Tool.run`
 * above is method shorthand: that fix is what lets `Tool<I, O>` values with different, narrower
 * `I`/`O` collapse into one `Tool[]` with no cast; this function is what gives each of them a real
 * `I`/`O` to narrow from in the first place.
 *
 * One copy, here, rather than one per family file. Four identical copies is four things that can
 * drift, and the drift test cannot see it: each tool documents its own copy, so a family whose
 * copy grew a difference would still render a TOOLS.md that matches itself.
 */
export function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(tool: Tool<I, O>): Tool<I, O> {
  return tool
}

/**
 * The three output shapes more than one family returns, for the same reason `defineTool` is here:
 * a second copy of a shape is a second thing to keep in step, and nothing in the suite compares
 * them. `SUMMARY` mirrors `Summary` below, `UNTRUSTED` mirrors `Untrusted`, and `REDUCTION`
 * mirrors what the query layer's readers put in their `reduction` field.
 */
export const REDUCTION = z.object({
  method: z.string(), from: z.number(), to: z.number(),
}).nullable()

export const SUMMARY = z.object({
  n: z.number(), min: z.number().nullable(), max: z.number().nullable(),
  mean: z.number().nullable(), median: z.number().nullable(),
  first: z.number().nullable(), last: z.number().nullable(),
})

export const UNTRUSTED = z.object({ untrustedText: z.string().nullable(), truncated: z.boolean() })

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
 * mechanical rather than stylistic lives at the adapters: the summary sentence - the first text
 * block of a tool result, the one an agent reads first - is composed only from values this app
 * generated, so no string from here ever reaches it.
 *
 * The summary sentence, not "the text blocks". An adapter also returns the structured content
 * serialised as a second text block, because MCP 2025-06-18 asks a tool returning
 * `structuredContent` to send the JSON too for clients written before that field existed. Text
 * from here is in that block - and arrives there exactly as it arrives in `structuredContent`
 * itself, inside an `untrustedText` field whose name says what it is. That is the difference the
 * rule turns on: a labelled field is this envelope working, and a sentence with a bare string in
 * it is the thing there would be no way to label.
 */
export function untrusted(text: string | null | undefined, max = MAX_TEXT): Untrusted {
  if (text === null || text === undefined) return { untrustedText: null, truncated: false }
  if (text.length <= max) return { untrustedText: text, truncated: false }
  return { untrustedText: text.slice(0, max), truncated: true }
}
