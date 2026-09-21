import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The Critical this round shipped once already: SyncEngine.kt put a session's `name` one level
// too deep, inside the sleep payload object rather than beside it, core read `name` off the POINT
// and got undefined, and the whole repository stayed green because the core test's fixture was a
// hand copy of the wire shape, held in step with SyncEngine.kt only by a comment. That is precisely
// how a fix can be a no-op nobody notices. This guard reads the real Kotlin source, the same idiom
// as companion-stale-source-drift.test.ts, so a regression here fails here rather than three layers
// downstream.
const root = new URL('../../', import.meta.url)
const SYNC_ENGINE_PATH = 'apps/android/app/src/main/java/com/haelan/android/SyncEngine.kt'
const source = readFileSync(new URL(SYNC_ENGINE_PATH, root), 'utf8')

/** Any class level function declaration, whatever its visibility. */
const DECLARATION = '\\n    (?:private |internal |public )?fun '

/**
 * The text of one class-level function, from its declaration to the next one.
 *
 * Visibility is deliberately not part of the match, and that is a correction rather than a
 * loosening. This guard matched `private fun` and broke the day toExercisePoints became `internal`
 * so a test could call it, while the placement it guards had not moved at all.
 *
 * It broke the right way, which is the part worth keeping: it said the function was not found,
 * rather than searching an empty string and passing. A guard that cannot find its subject must say
 * so, because the alternative is a green test watching nothing.
 */
function functionBody(functionName: string): string {
  const declared = new RegExp(`${DECLARATION}${functionName}\\(`).exec(source)
  expect(declared, `${SYNC_ENGINE_PATH}: '${functionName}' not found - has it moved or been renamed?`).not.toBeNull()
  const start = declared!.index
  const after = new RegExp(DECLARATION, 'g')
  after.lastIndex = start + 1
  const nextFun = after.exec(source)?.index ?? -1
  expect(
    nextFun,
    `${SYNC_ENGINE_PATH}: could not find the end of '${functionName}' - no class level function declaration `
    + 'follows it, so this guard cannot bound the function it needs to read.',
  ).toBeGreaterThan(-1)
  return source.slice(start, nextFun)
}

/**
 * The `.put(...)` calls chained onto the same object as `.put("<payloadKey>", ...)`, read backwards
 * from it and stopping at the first line that is not another link in that chain.
 *
 * Reading the chain is what makes this guard survive both shapes the payload is written in. Sleep
 * builds its payload inline (`.put("sleep", JSONObject()`), exercise assigns it to a local first
 * and passes the variable (`.put("exercise", exercise)`), because a route has to be folded in
 * conditionally after the object exists.
 *
 * Text order cannot tell those apart, and that matters: in the variable shape a wrongly nested
 * `name` moves INTO the `val exercise = JSONObject()` block, which sits ABOVE the point builder.
 * The old assertion asked only whether `.put("name"` came before the payload put, so the variable
 * shape would have answered yes while carrying the exact defect this file exists to catch. Chain
 * membership asks the real question instead: is `name` a sibling of the payload, on the point.
 */
function chainEndingAtPayload(functionName: string, payloadKey: string): string[] {
  const body = functionBody(functionName)
  const lines = body.split('\n')
  const payloadPut = `.put("${payloadKey}", `
  const at = lines.findIndex((line) => line.trimStart().startsWith(payloadPut))
  expect(
    at,
    `${SYNC_ENGINE_PATH}: '${functionName}' has no '${payloadPut}...)' call starting a line - has the `
    + 'payload wrapper moved, been renamed, or been folded onto another line? This guard reads the '
    + 'chain line by line, so it cannot answer the question it was written to answer.',
  ).toBeGreaterThan(-1)
  const chain: string[] = []
  for (let i = at; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line.startsWith('//')) continue
    if (!line.startsWith('.put(')) break
    chain.push(line)
  }
  return chain
}

/**
 * `name` must be a SIBLING of the payload object, chained onto the same point-level JSONObject,
 * never a field inside the payload: mapSessions.ts reads `name` off the point itself
 * (valueAt(point, 'name')) and never looks inside the payload for it, the same level Google's own
 * payloads carry it at.
 */
function assertNameIsSiblingOfPayload(functionName: string, payloadKey: string): void {
  expect(
    functionBody(functionName).includes('.put("name", '),
    `${SYNC_ENGINE_PATH}: '${functionName}' no longer calls '.put("name", ...)' at all - the `
    + 'session id this app sends has disappeared, not just moved.',
  ).toBe(true)
  const chain = chainEndingAtPayload(functionName, payloadKey)
  expect(
    chain.some((line) => line.startsWith('.put("name", ')),
    `${SYNC_ENGINE_PATH}: in '${functionName}', '.put("name", ...)' is no longer chained onto the `
    + `same object as '.put("${payloadKey}", ...)'. The function still sends a name somewhere, so `
    + `it has moved rather than gone: the likely place is inside the ${payloadKey} payload itself. `
    + 'mapSessions.ts reads `name` off the POINT, never out of the payload, so this silently falls '
    + 'back to the interval start as the session identity - exactly the Critical this round already '
    + 'shipped once, where the app put name one level too deep and every test still passed because '
    + `the core fixture was a hand copy rather than the app's real JSON. Chain '.put("name", ...)' `
    + `back onto the same JSONObject that carries '.put("${payloadKey}", ...)'. The chain this guard `
    + `read was: ${chain.join(' ') || '(nothing)'}`,
  ).toBe(true)
}

describe('SyncEngine.kt: session name stays a sibling of its payload', () => {
  it('sleep: name is not nested inside the sleep object', () => {
    assertNameIsSiblingOfPayload('toSleepPoints', 'sleep')
  })

  it('exercise: name is not nested inside the exercise object', () => {
    assertNameIsSiblingOfPayload('toExercisePoints', 'exercise')
  })
})

/**
 * The two route keys go ON the exercise payload, and only source can say so.
 *
 * ExerciseRouteTest.kt cannot reach this: the ExerciseSessionRecord constructor that carries an
 * ExerciseRouteResult is Kotlin-internal to connect-client, so no unit test can build a record
 * whose route was withheld, and the branch that writes `routeConsentRequired` never runs in a
 * test. What is left is the text, which is enough to catch the one mistake that matters - a key
 * written onto the POINT instead of the payload.
 *
 * That mistake is not hypothetical here. The session `name` shipped one level too deep on this
 * exact function, every test stayed green, and the core fixture agreed with the bug because it was
 * a hand copy. mapSessions.ts reads both of these off the payload object, beside `interval` and
 * `exerciseType`.
 */
describe('SyncEngine.kt: the route keys sit on the exercise payload', () => {
  const body = functionBody('toExercisePoints')

  it.each(['route', 'routeConsentRequired'])("puts %s on the payload, not on the point", (key) => {
    expect(
      body.includes(`exercise.put("${key}"`),
      `${SYNC_ENGINE_PATH}: 'toExercisePoints' does not call 'exercise.put("${key}", ...)'. That `
      + 'call is what puts the key on the exercise payload object, the level mapSessions.ts reads '
      + 'it at. If it moved to the point-level chain it is now a sibling of "exercise" rather than '
      + 'a field inside it, core will never look there, and nothing else in this repository would '
      + 'go red - the Kotlin test cannot build a withheld route at all.',
    ).toBe(true)
  })

  it('sends the flag only when a route was withheld, never unconditionally', () => {
    // An unconditional put would print the sentence under every workout from a phone, which is the
    // defect the removed "may have been unreadable" sentence already was.
    expect(
      /if \(routeConsentRequired\([^)]*\)\) exercise\.put\("routeConsentRequired", true\)/.test(body),
      `${SYNC_ENGINE_PATH}: 'routeConsentRequired' is no longer put behind a routeConsentRequired() `
      + 'check. Sent unconditionally it would claim every workout had a route withheld, including '
      + 'every indoor session, which is the same wrong sentence under every workout that this '
      + 'field exists to replace.',
    ).toBe(true)
  })
})
