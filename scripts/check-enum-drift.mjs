// Diffs the checked in enum catalogue against the API's live discovery document.
//
// A script rather than a test, deliberately: a test that needs the network is a test that fails on
// a train, and this answers a question about the world rather than about the code. Run it when
// starting an API touching milestone.
//
// Usage: pnpm check:enums
const URL = 'https://health.googleapis.com/$discovery/rest?version=v4'

const { EXERCISE_TYPES, SLEEP_STAGE_TYPES } = await import('../packages/core/src/api/enums.ts')

const response = await fetch(URL)
if (!response.ok) {
  console.error(`Could not fetch the discovery document: ${response.status} ${response.statusText}`)
  process.exit(2)
}
const doc = await response.json()

/**
 * Every enum in the document, keyed by the property name that declares it, as a list of value
 * arrays rather than one. `type` is not unique here: the schema reuses it for `Sleep.type`
 * (CLASSIC/STAGES, an unrelated three value enum) as well as `SleepStage.type` and
 * `StageSummary.type` (the stage vocabulary this script actually wants). Keying a single Map entry
 * by property name would let whichever one the traversal visits last silently win; collecting every
 * match instead lets the caller pick the right one deliberately.
 */
function enumsByProperty(node, into = new Map()) {
  if (node === null || typeof node !== 'object') return into
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === 'object' && Array.isArray(value.enum)) {
      const matches = into.get(key) ?? []
      matches.push(value.enum)
      into.set(key, matches)
    }
    enumsByProperty(value, into)
  }
  return into
}

const live = enumsByProperty(doc)

/**
 * Resolves `property` to the one live enum meant to be compared against `checkedIn`. When the name
 * is ambiguous, picks the candidate whose values are a superset of what is already checked in,
 * rather than the first or last one found, since traversal order is an accident of the document's
 * key ordering and not something to depend on.
 */
function resolve(property, checkedIn) {
  const candidates = live.get(property)
  if (candidates === undefined) return undefined
  if (candidates.length === 1) return candidates[0]
  return candidates.find((values) => checkedIn.every((v) => values.includes(v)))
}

let drifted = false

for (const [property, checkedIn] of [['exerciseType', EXERCISE_TYPES], ['type', SLEEP_STAGE_TYPES]]) {
  const found = resolve(property, checkedIn)
  if (found === undefined) {
    console.error(`${property}: no matching enum found in the document. The schema may have moved it.`)
    drifted = true
    continue
  }
  const added = found.filter((v) => !checkedIn.includes(v))
  const removed = checkedIn.filter((v) => !found.includes(v))
  if (added.length === 0 && removed.length === 0) {
    console.log(`${property}: ${found.length} values, unchanged.`)
    continue
  }
  drifted = true
  if (added.length > 0) console.error(`${property}: ${added.length} added -> ${added.join(', ')}`)
  if (removed.length > 0) console.error(`${property}: ${removed.length} removed -> ${removed.join(', ')}`)
}

process.exit(drifted ? 1 : 0)
