/**
 * The MCP server on stdio: one process, bound to one person, speaking JSON-RPC on its own
 * standard input and output.
 *
 *   node --experimental-strip-types apps/server/src/mcp.ts --person robin
 *   docker exec -i haelan node --experimental-strip-types apps/server/src/mcp.ts --person robin
 *
 * It lives beside the server for the same reason `admin.ts` does: the Dockerfile copies
 * `packages/core/src` and `apps/server/src` into the runtime image and nothing else, so a tool
 * placed in `scripts/` exists only in a checkout - which is not where an agent on a homelab
 * machine is going to find it. The data directory is read the same way too, from the config's
 * `HAELAN_DATA_DIR`, so this and the server cannot disagree about which instance they mean.
 *
 * This file is an adapter and nothing more. Every tool is a description, two Zod shapes and a
 * function in `mcp/catalogue.ts`, with no MCP type anywhere in it; M4a-3's `POST /mcp` is a second
 * adapter over that same catalogue and does not touch this file.
 *
 * Two properties are load-bearing here, and both are this file's to keep:
 *
 * 1. Stdout is the protocol. Every diagnostic goes to `console.error`, because a single line of
 *    prose on stdout corrupts the JSON-RPC stream for the rest of the session. The only test that
 *    can see a violation is the one that spawns this process
 *    (`apps/server/test/mcp-stdio.test.ts`), so there is nothing else guarding it.
 *
 * 2. The text block an agent reads first is composed only from values this app generated. See
 *    `summarise` below for what that means mechanically.
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AccountStore, ConfigError, PeopleStore, PersonQuery, openReadOnly } from '@haelan/core'
import type { DbOrTx } from '@haelan/core'
import { readConfig } from './config.ts'
import { CATALOGUE } from './mcp/catalogue.ts'

const USAGE = `usage: node --experimental-strip-types apps/server/src/mcp.ts [--person <who>]

  --person <who>  an account username, or a person id. Required once this instance holds more
                  than one person, because a session answers for exactly one of them.

The data directory comes from HAELAN_DATA_DIR, the same as the server reads it. The database is
opened read-only: this process migrates nothing and writes nothing.`

/**
 * The identity in the MCP handshake, not the app's release version.
 *
 * Nothing branches on it - no client negotiates behaviour against a haelan version - so wiring it
 * to the repository's version would make every release a change to a protocol field that means
 * nothing to whoever reads it.
 */
const SERVER_INFO = { name: 'haelan', version: '1' }

interface Args { person: string | undefined }

export function parseArgs(argv: readonly string[]): Args {
  let person: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--person') {
      const value = argv[i + 1]
      // Refused rather than treated as absent. `--person` with nothing after it is a shell that
      // expanded an empty variable, and falling back to "the only person" there would silently
      // answer for somebody the caller did not name.
      if (value === undefined || value.startsWith('--')) {
        throw new ConfigError('--person needs an account username or a person id after it')
      }
      person = value
      i++
    } else if (arg.startsWith('--person=')) {
      person = arg.slice('--person='.length)
      if (person === '') throw new ConfigError('--person needs an account username or a person id after it')
    } else {
      throw new ConfigError(`unknown argument '${arg}'.\n${USAGE}`)
    }
  }
  return { person }
}

/**
 * Which person this session answers for, decided once at startup and never again.
 *
 * A username is tried first and resolving one proves the account exists, which is the whole point
 * of accepting a username at all: a mistyped `--person robbin` fails here, at startup, with a
 * sentence. Passed through as a person id it would instead produce a `PersonQuery` for a person
 * who does not exist, and every tool would answer empty - an agent reading that reports a
 * household member with no data rather than a typo, and those are different claims about
 * somebody's health record.
 *
 * The flag may be omitted only on an instance with exactly one person, where there is nothing to
 * choose between. With two it refuses and names them, because picking either would be inventing
 * an answer to the question the operator did not answer.
 *
 * Ids, not display names, in that refusal: a display name is free text a person typed, and
 * `--person` takes an id or a username anyway, so listing names would print something that is
 * both untrusted and unusable as an argument.
 */
export function resolvePerson(db: DbOrTx, flag: string | undefined): string {
  const people = new PeopleStore(db)
  if (flag === undefined) {
    const all = people.list()
    if (all.length === 1) return all[0]!.id
    if (all.length === 0) throw new ConfigError('this instance holds no people, so there is nothing to serve.')
    const ids = all.map((person) => person.id).join(', ')
    throw new ConfigError(
      `this instance holds ${all.length} people, so --person says which one to serve. Their ids are: ${ids}.`,
    )
  }

  // Lower cased and trimmed the way AccountStore stores and looks up every username, so the
  // spelling that signs in at the web UI is the spelling that works here.
  const username = flag.trim().toLowerCase()
  const account = new AccountStore(db).list().find((row) => row.username === username)
  if (account !== undefined) return account.personId

  if (people.get(flag) !== null) return flag
  throw new ConfigError(
    `no account or person named '${flag}'. Pass --person an account username or a person id.`,
  )
}

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
 * Registers one catalogue entry as an MCP tool.
 *
 * `registerTool` validates the call's arguments against this same `inputSchema` and raises
 * `InvalidParams` before it ever reaches this callback - verified in the SDK's own source, where
 * the CallTool handler awaits `validateToolInput` and only then calls the handler. That is what
 * the soundness of `Tool.run`'s bivariant signature rests on: `run` is typed for arguments this
 * shape, and something has to be the thing that makes a malformed call fail before it gets there.
 * If a future SDK stops validating, a tool body starts receiving whatever was sent, and no type in
 * this repository would notice - so if that line ever moves, this adapter grows a `safeParse` of
 * its own.
 *
 * Throwing from `run` is the intended way for a tool to refuse: the SDK turns a thrown error into
 * a tool result with `isError` set, which is a refusal an agent can read, and not a dead session.
 */
function register(server: McpServer, tool: (typeof CATALOGUE)[number], query: PersonQuery): void {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema },
    (args) => {
      const structuredContent = tool.run(query, args)
      return {
        content: [{ type: 'text', text: summarise(tool.name, tool.outputSchema, structuredContent) }],
        structuredContent,
      }
    },
  )
}

export async function serve(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { person } = parseArgs(argv)
  const dataDir = resolve(readConfig(env).dataDir)
  const db = openReadOnly(dataDir)
  const personId = resolvePerson(db, person)
  const query = new PersonQuery(db, personId)

  const server = new McpServer(SERVER_INFO)
  for (const tool of CATALOGUE) register(server, tool, query)
  // Connected before the diagnostic, so stdin is being read from the first moment this process is
  // visibly alive. stderr, here and everywhere: see the note at the top of this file.
  await server.connect(new StdioServerTransport())
  console.error(`haelan mcp: serving ${CATALOGUE.length} tools for person ${personId} from ${dataDir}`)
}

if (import.meta.main) {
  try {
    await serve(process.argv.slice(2), process.env)
  } catch (err) {
    // One sentence and a non-zero exit. A stack trace here would be the first thing an operator
    // sees after a `docker exec` that did not work, and it says less than the sentence does.
    console.error(err instanceof ConfigError ? err.detail : String(err))
    process.exit(1)
  }
}
