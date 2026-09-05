// Diffs the checked in enum catalogue against the API's live discovery document.
//
// A script rather than a test, deliberately: a test that needs the network is a test that fails on
// a train, and this answers a question about the world rather than about the code. Run it when
// starting an API touching milestone.
//
// Usage: pnpm check:enums
const URL = 'https://health.googleapis.com/$discovery/rest?version=v4'

const { EXERCISE_TYPES, SLEEP_STAGE_TYPES } = await import('../packages/core/src/api/enums.ts')
const { DATA_TYPES } = await import('../packages/core/src/api/catalogue.ts')
const { dataTypesNamedIn } = await import('../packages/core/src/api/discoveryDataTypes.ts')

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

/** True when two enum value lists contain exactly the same values, ignoring order. */
function sameValues(a, b) {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((v, i) => v === sortedB[i])
}

/**
 * Resolves `property` to the live enum meant to be compared against `checkedIn`, or explains why
 * it could not. `type` is not unique in this schema: `Sleep.type`, `SleepStage.type` and
 * `StageSummary.type` all use it, and picking the first candidate whose values are a superset of
 * `checkedIn` (as an earlier version of this function did) works only because the latter two
 * happen to be identical today. If they ever diverged, the one that lost a value would fail the
 * superset test and be silently skipped while the other still passed, and this script would print
 * "unchanged" while comparing something other than what it looks like it is comparing, which is
 * the exact failure this narrowing exists to prevent. So every candidate is checked, and when more
 * than one is a superset and they disagree with each other, that disagreement is returned as its
 * own outcome rather than resolved by picking one.
 */
function resolve(property, checkedIn) {
  const candidates = live.get(property)
  if (candidates === undefined) return { status: 'not-found' }
  const supersets = candidates.filter((values) => checkedIn.every((v) => values.includes(v)))
  if (supersets.length === 0) return { status: 'no-superset', candidateCount: candidates.length }
  const [first, ...rest] = supersets
  if (rest.some((values) => !sameValues(values, first))) return { status: 'ambiguous', supersets }
  return { status: 'ok', values: first }
}

let drifted = false

for (const [property, checkedIn] of [['exerciseType', EXERCISE_TYPES], ['type', SLEEP_STAGE_TYPES]]) {
  const result = resolve(property, checkedIn)

  if (result.status === 'not-found') {
    console.error(`${property}: no enum declared under that property name anywhere in the document. The schema may have moved it.`)
    drifted = true
    continue
  }
  if (result.status === 'no-superset') {
    console.error(`${property}: found ${result.candidateCount} enum(s) under that name, but none contains every checked in value. The schema may have removed one.`)
    drifted = true
    continue
  }
  if (result.status === 'ambiguous') {
    console.error(`${property}: ${result.supersets.length} candidate enums under that name each contain every checked in value, but they disagree with each other, so which one this should be compared against is not decidable from the property name alone:`)
    result.supersets.forEach((values, i) => {
      const extra = values.filter((v) => !result.supersets[0].includes(v))
      const missing = result.supersets[0].filter((v) => !values.includes(v))
      const diff = i === 0 ? '' : ` (vs candidate 1: +${extra.length}/-${missing.length})`
      console.error(`${property}: candidate ${i + 1}: ${values.length} values${diff}`)
    })
    drifted = true
    continue
  }

  const found = result.values
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

// Data types are a different shape of check than the enums above: there is no `dataTypes.list`
// method, and no schema enumerates them either. `users.dataTypes.dataPoints` takes the data type
// as a path parameter, so the only place identifiers surface is prose - the rollup-value
// descriptions - and only rollup-capable types are ever named there. That is a known, permanent
// blind spot, not a bug in this check, so it is reported unconditionally rather than folded into
// `drifted`: a type the catalogue lacks that never happens to be named here would otherwise make a
// dirty run print clean, which is the exact failure a curated map was rejected for.
const named = dataTypesNamedIn(doc)
const catalogued = DATA_TYPES.map((t) => t.id)
const namedButUncatalogued = named.filter((id) => !catalogued.includes(id))
const cataloguedButUnnamed = catalogued.filter((id) => !named.includes(id))

console.log('')
console.log(`data types: document names ${named.length} in rollup-value descriptions, catalogue declares ${catalogued.length}.`)
if (namedButUncatalogued.length > 0) {
  console.log(`data types: named in the document but not in the catalogue -> ${namedButUncatalogued.join(', ')}`)
} else {
  console.log('data types: nothing named in the document is missing from the catalogue.')
}
if (cataloguedButUnnamed.length > 0) {
  console.log(`data types: in the catalogue but never named in the document -> ${cataloguedButUnnamed.join(', ')}`)
} else {
  console.log('data types: everything in the catalogue is named in the document.')
}
console.log('data types: this check sees only rollup-capable types, named in prose the document happens to carry - it cannot see the rest of the catalogue drifting. The release notes at https://developers.google.com/health/release-notes remain the authority.')

process.exit(drifted ? 1 : 0)
