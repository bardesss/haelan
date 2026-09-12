/**
 * The half both transports have in common: every catalogue entry registered on one McpServer,
 * bound to one person's query, with no transport chosen here.
 *
 * Its own module rather than a function exported from `mcp.ts`, because `mcp.ts` is a process
 * entry point - it reads `HAELAN_DATA_DIR`, opens a read-only database and has a top-level `await`
 * behind an argv check - and the HTTP route in `http.ts` runs inside the server process, where
 * none of that belongs. `mcp.ts` imports from here; nothing imports `mcp.ts`.
 *
 * Named `buildMcpServer`, not `buildServer`, because `app.ts` already exports a `buildServer` that
 * builds the Fastify instance, and a reader who meets both in one file has no way to tell which is
 * which.
 *
 * The summary sentence - the first text block, the one an agent reads first - is composed only
 * from values this app generated. See `summarise` below for what that means mechanically.
 *
 * Not "the text blocks": there are two, and the second is the structured content serialised,
 * which the spec asks for and which carries a note's body and a device's name like any other
 * field. That is not a hole in the rule, it is the rule's other half: free text arrives there
 * labelled, inside an `untrustedText` field whose name says what it is, which is what the
 * envelope in `mcp/contract.ts` exists to do. The sentence is the one place a string can reach
 * an agent with nothing around it saying where it came from, so the sentence is what the rule
 * binds.
 */
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PersonQuery } from '@haelan/core'
import { CATALOGUE } from './catalogue.ts'

/**
 * The identity in the MCP handshake, not the app's release version.
 *
 * Nothing branches on it - no client negotiates behaviour against a haelan version - so wiring it
 * to the repository's version would make every release a change to a protocol field that means
 * nothing to whoever reads it.
 */
const SERVER_INFO = { name: 'haelan', version: '1' }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Keys whose string value is a date this app formatted, rather than text somebody wrote.
 *
 * A whitelist rather than a regex alone: a note body of `2026-01-02` is still a note body, and
 * the rule below has to hold on the shape of the result, not on how the string happens to read.
 */
const DATE_KEYS = new Set(['localDate', 'from', 'to', 'on'])

/** How deep into a result the summary looks. Arrays are counted, never walked into. */
const MAX_DEPTH = 2

/** Enough to characterise an answer; past this the structured content is the thing to read. */
const MAX_PARTS = 12

/**
 * The summary sentence that rides alongside every structured result.
 *
 * The rule that makes the untrusted contract mechanical rather than stylistic lives here, and it
 * is stated as what may go in rather than as what may not: counts of arrays, finite numbers,
 * booleans, and strings that are both under a date key and shaped like a date. Every other string
 * in a result is dropped, so a note's body, a device's display name and a workout's own title
 * cannot reach the first sentence an agent reads no matter how they are nested - they travel in
 * the structured content, where a field name says what they are.
 *
 * Stated the other way round it would be one `untrusted` envelope away from wrong every time a
 * tool grows a field. Stated this way, a new free-text field is excluded by default and has to be
 * deliberately let in.
 *
 * The walk is driven by the tool's declared `outputSchema`, not by the keys of the result it is
 * summarising, and that is the load-bearing half of the claim two paragraphs up that "the key
 * names are safe, because every one of them is a literal in this repository's own source". Walking
 * the result made that a statement about every tool that happens to exist rather than a property
 * of this function: a tool answering a record keyed by user-controlled text - a `bySource` keyed by
 * a device's display name, or M4b's `sql_query` answering rows keyed by column names and
 * agent-chosen aliases - would have put that text straight into the prose as a key, past a filter
 * that only ever inspected values. Driven by the schema, a key can only be a literal somebody
 * wrote in a `.ts` file here, and a field the result carries but the schema does not declare is
 * not summarised at all.
 *
 * It closes a second gap for nothing extra: the summary now describes the shape the tool promised
 * rather than whatever `run` happened to return, so the distinction between the two - which the
 * SDK validates the result against anyway - stops being one this sentence can fall on the wrong
 * side of.
 */
export function summarise(toolName: string, outputSchema: z.ZodRawShape, result: unknown): string {
  const parts: string[] = []
  collect(outputSchema, result, '', 0, parts)
  if (parts.length === 0) return `${toolName}: answered. The structured content carries it.`
  const shown = parts.slice(0, MAX_PARTS)
  const tail = parts.length > shown.length ? ', and more in the structured content' : ''
  return `${toolName}: ${shown.join(', ')}${tail}.`
}

/**
 * The declared type of a field, with `optional` and `nullable` peeled off - the same unwrapping
 * `scripts/generate-tools-doc.mjs` does, for the same reason: nearly every field on this surface
 * is wrapped in one or both, and the wrapper says nothing about what may be printed.
 */
function unwrap(schema: z.ZodRawShape[string]): z.ZodRawShape[string] {
  let s = schema
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.def.innerType
  return s
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collect(
  shape: z.ZodRawShape, value: unknown, path: string, depth: number, parts: string[],
): void {
  if (!isRecord(value)) return
  // Belt and braces: no string ever leaves this walk except a dated one, so an untrusted envelope
  // is already inert. Skipped by shape anyway, so a reader does not have to prove that twice.
  // Recognised from the declared shape rather than from the value, so an envelope whose text
  // happened to be absent is skipped exactly like one whose text is there.
  if ('untrustedText' in shape) return

  for (const [key, declared] of Object.entries(shape)) {
    const base = unwrap(declared)
    const field = value[key]
    const at = path === '' ? key : `${path}.${key}`
    if (base instanceof z.ZodArray) {
      if (Array.isArray(field)) parts.push(`${at} ${field.length}`)
    } else if (base instanceof z.ZodNumber) {
      if (typeof field === 'number' && Number.isFinite(field)) parts.push(`${at} ${round(field)}`)
    } else if (base instanceof z.ZodBoolean) {
      if (typeof field === 'boolean') parts.push(`${at} ${field ? 'yes' : 'no'}`)
    } else if (base instanceof z.ZodString) {
      if (typeof field === 'string' && DATE_KEYS.has(key) && ISO_DATE.test(field)) {
        parts.push(`${at} ${field}`)
      }
    } else if (base instanceof z.ZodObject && depth + 1 < MAX_DEPTH) {
      collect(base.def.shape, field, at, depth + 1, parts)
    }
    // Every other declared type - an enum, a record, a union, anything a later tool reaches for -
    // falls through to nothing. Excluded by default is the point: a shape nobody thought about
    // here is silent rather than printed.
  }
}

// A mean over a week of step counts is a number with seventeen digits after the point, and none of
// them are information. The structured content carries the exact value.
const round = (value: number): number => Math.round(value * 100) / 100

/**
 * Told about each tool call as it finishes, so `POST /mcp` can write a row to `mcp_calls` without
 * this file knowing that a call log exists. stdio passes nothing: `openReadOnly` cannot write.
 *
 * It is handed a tool name, a count and a duration, and never the arguments. That is not this
 * function's politeness - `mcp_calls` has no column for them - but the signature is where it is
 * cheapest to keep true, since a later caller cannot log what it was never given.
 */
export interface McpCallObserver {
  (call: { tool: string, rowCount: number | null, durationMs: number, outcome: 'ok' | 'error' }): void
}

/**
 * How much came back, for the call log's own column.
 *
 * Counted over the tool's declared `outputSchema` rather than over the result, the same walk
 * `summarise` does and for a related reason: driven by the result, a tool answering a record keyed
 * by user-controlled text would have this function iterating keys nobody in this repository wrote.
 * Here it can only look at fields a `.ts` file declares.
 *
 * Top-level arrays only, and no recursion. This is a rough size, not an inventory: "a call that
 * returned forty thousand rows in a minute" is the question the log exists to answer, and nesting
 * would make one tool's number incomparable with another's.
 *
 * `sql_query` is the case where that number reads most like a promise it is not: it declares both
 * `columns` and `rows`, so a 3-column, 12-row answer sums to 15, and that sum - not 12 - is what
 * Settings → Agent access shows for the call.
 */
export function countRows(outputSchema: z.ZodRawShape, result: unknown): number {
  if (!isRecord(result)) return 0
  let total = 0
  for (const [key, declared] of Object.entries(outputSchema)) {
    if (!(unwrap(declared) instanceof z.ZodArray)) continue
    const field = result[key]
    if (Array.isArray(field)) total += field.length
  }
  return total
}

/**
 * Registers one catalogue entry as an MCP tool.
 *
 * `registerTool` validates the call's arguments against this same `inputSchema` and raises
 * `InvalidParams` before it ever reaches this callback - the SDK's CallTool handler awaits
 * `validateToolInput` and only then calls the handler. That is what the soundness of `Tool.run`'s
 * bivariant signature rests on: `run` is typed for arguments this shape, and something has to be
 * the thing that makes a malformed call fail before it gets there. If a future SDK stops
 * validating, a tool body starts receiving whatever was sent, and no type in this repository would
 * notice.
 *
 * So a test asks, rather than a comment asserting it: `apps/server/test/mcp-sdk.test.ts` drives a
 * real client and server over an in-memory transport, sends `query_series` a string where the
 * schema declares a number, and requires both that the call is refused and that `run` was never
 * entered. That is the line this adapter would have to grow a `safeParse` of its own the day it
 * moves, and a weekly Dependabot bump of an `^1.30.0` dependency is how it would move.
 *
 * Throwing from `run` is the intended way for a tool to refuse: the SDK turns a thrown error into
 * a tool result with `isError` set, which is a refusal an agent can read, and not a dead session.
 *
 * That path does not pass through `summarise`, which puts core's error messages inside the
 * untrusted rule's scope rather than outside it. A `ConfigError` thrown by `PersonQuery` reaches
 * an agent as prose, unfiltered, so a message template there must interpolate only what a caller
 * sent or what this repository's own source names - which is what all seventeen of them do today
 * (`requireSource` lists source ids rather than display names for exactly this reason). Whoever
 * writes the eighteenth: not a display name, not a note body, not a workout's own title.
 *
 * The observer is told about a throw before it is rethrown, so a refusal reaches the call log too.
 */
function register(
  server: McpServer, tool: (typeof CATALOGUE)[number], query: PersonQuery,
  observe: McpCallObserver | undefined,
): void {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema },
    async (args) => {
      // performance.now(), and a duration rather than two timestamps: every other clock in this
      // app is injected so a test can freeze it, and a frozen clock would make every duration
      // zero. An elapsed measure is not a timestamp, so it does not belong to that rule - the
      // row's `at_ms` still comes from the injected clock at the route.
      const started = performance.now()
      let structuredContent: Record<string, unknown>
      try {
        structuredContent = await tool.run(query, args) as Record<string, unknown>
      } catch (error) {
        // Reported before it is rethrown. A refused call is the half of the log that matters most
        // - the SDK turns this throw into a tool result with `isError` set, which an agent reads
        // and retries, and a log that only held successes would show a probing agent as silence.
        observe?.({
          tool: tool.name, rowCount: null,
          durationMs: Math.round(performance.now() - started), outcome: 'error',
        })
        throw error
      }
      observe?.({
        tool: tool.name, rowCount: countRows(tool.outputSchema, structuredContent),
        durationMs: Math.round(performance.now() - started), outcome: 'ok',
      })
      return {
        content: [
          { type: 'text', text: summarise(tool.name, tool.outputSchema, structuredContent) },
          // The same answer again, serialised. MCP 2025-06-18's Structured Content section asks a
          // tool returning `structuredContent` to also return the JSON as a text block, for
          // clients written before that field existed - and a client reading only `content`
          // otherwise sees the summary sentence and nothing else, which on describe_person is
          // `describe_person: sources 0.` with the person, the timezone and every source id left
          // in a field it never looks at.
          { type: 'text', text: JSON.stringify(structuredContent) },
        ],
        structuredContent,
      }
    },
  )
}

/**
 * Every catalogue entry registered on one server, bound to one person's query.
 *
 * Separate from `serve` so a test can drive the real SDK over an in-memory transport - which is
 * the only way to ask what a client actually receives, `content` blocks and argument validation
 * alike, without spawning a process and speaking JSON-RPC by hand. No transport is chosen here:
 * this is the half `serve` and M4a-3's `POST /mcp` have in common.
 */
export function buildMcpServer(query: PersonQuery, observe?: McpCallObserver): McpServer {
  const server = new McpServer(SERVER_INFO)
  for (const tool of CATALOGUE) register(server, tool, query, observe)
  return server
}
