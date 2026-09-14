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
 * The adapter is `mcp/adapter.ts`; this file chooses a transport - stdio - and a person.
 *
 * One property is load-bearing here, and it is this file's alone to keep:
 *
 * 1. Stdout is the protocol. Every diagnostic goes to `console.error`, because a single line of
 *    prose on stdout corrupts the JSON-RPC stream for the rest of the session. The only test that
 *    can see a violation is the one that spawns this process
 *    (`apps/server/test/mcp-stdio.test.ts`), so there is nothing else guarding it.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AccountStore, ConfigError, PeopleStore, PersonQuery, openReadOnly } from '@haelan/core'
import type { DbOrTx } from '@haelan/core'
import { readConfig } from './config.ts'
import { CATALOGUE } from './mcp/catalogue.ts'
import { buildMcpServer } from './mcp/adapter.ts'

const USAGE = `usage: node --experimental-strip-types apps/server/src/mcp.ts [--person <who>]

  --person <who>  an account username, or a person id. Required once this instance holds more
                  than one person, because a session answers for exactly one of them.

The data directory comes from HAELAN_DATA_DIR, the same as the server reads it. The database is
opened read-only: this process migrates nothing and writes nothing.`

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

export async function serve(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { person } = parseArgs(argv)
  const dataDir = resolve(readConfig(env).dataDir)
  const db = openReadOnly(dataDir)
  const personId = resolvePerson(db, person)

  const server = buildMcpServer(new PersonQuery(db, personId))
  // Connected before the diagnostic, so stdin is being read from the first moment this process is
  // visibly alive. stderr, here and everywhere: see the note at the top of this file.
  await server.connect(new StdioServerTransport())
  console.error(`haelan mcp: serving ${CATALOGUE.length} tools for person ${personId} from ${dataDir}`)
}

// Not `import.meta.main`, which says this in one word and is the wrong word here: it landed in
// Node 22.18, and this package's engines floor is >=22.14, where it is plain `undefined`. The gate
// would be silently false - this process would start, serve nothing, and exit with an empty
// stdout, a failure that reads as a protocol bug rather than a version one. Keep the path
// comparison until the floor moves past 22.18; `test/engine-floor.test.ts` holds that.
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    await serve(process.argv.slice(2), process.env)
  } catch (err) {
    // One sentence and a non-zero exit. A stack trace here would be the first thing an operator
    // sees after a `docker exec` that did not work, and it says less than the sentence does.
    console.error(err instanceof ConfigError ? err.detail : String(err))
    process.exit(1)
  }
}
