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

/** The text of one class-level `private fun`, from its declaration to the next one. */
function functionBody(functionName: string): string {
  const start = source.indexOf(`private fun ${functionName}(`)
  expect(start, `${SYNC_ENGINE_PATH}: '${functionName}' not found - has it moved or been renamed?`).toBeGreaterThan(-1)
  const nextFun = source.indexOf('\n    private fun ', start + 1)
  expect(
    nextFun,
    `${SYNC_ENGINE_PATH}: could not find the end of '${functionName}' - no class level 'private fun' `
    + 'follows it, so this guard cannot bound the function it needs to read.',
  ).toBeGreaterThan(-1)
  return source.slice(start, nextFun)
}

/**
 * `name` must be a SIBLING of the payload object (`.put("name", ...)` before
 * `.put("<payloadKey>", JSONObject()`), never a field inside it: mapSessions.ts
 * (packages/core/src/query/personQuery.ts) reads `name` off the point itself and never looks
 * inside the payload for it, the same level Google's own payloads carry it at.
 */
function assertNameIsSiblingOfPayload(functionName: string, payloadKey: string): void {
  const body = functionBody(functionName)
  const nameIndex = body.indexOf('.put("name"')
  const payloadIndex = body.indexOf(`.put("${payloadKey}", JSONObject()`)
  expect(
    nameIndex,
    `${SYNC_ENGINE_PATH}: '${functionName}' no longer calls '.put("name", ...)' at all - the `
    + 'session id this app sends has disappeared, not just moved.',
  ).toBeGreaterThan(-1)
  expect(
    payloadIndex,
    `${SYNC_ENGINE_PATH}: '${functionName}' has no '.put("${payloadKey}", JSONObject()' call - has `
    + 'the payload wrapper moved or been renamed?',
  ).toBeGreaterThan(-1)
  expect(
    nameIndex < payloadIndex,
    `${SYNC_ENGINE_PATH}: in '${functionName}', '.put("name", ...)' now comes AFTER `
    + `'.put("${payloadKey}", JSONObject()' opens, which means name moved INSIDE the ${payloadKey} `
    + 'payload object instead of staying a sibling of it. mapSessions.ts reads `name` off the '
    + 'POINT, never out of the payload, so this silently falls back to the interval start as the '
    + 'session identity - exactly the Critical this round already shipped once, where the app put '
    + 'name one level too deep and every test still passed because the core fixture was a hand copy '
    + `rather than the app's real JSON. Move '.put("name", ...)' back out to be a sibling of `
    + `'.put("${payloadKey}", ...)', not a field inside it.`,
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
