import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  PersonQuery, createTestDatabase, seedPerson, ConfigError,
} from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { CATALOGUE } from '../src/mcp/catalogue.ts'
import {
  ALICE_FINGERPRINTS, BART_TEXT_FINGERPRINTS, BART_NUMBER_FINGERPRINTS, TOOL_INPUTS,
  seedToolData, numberLeak,
} from './mcp-fixtures.ts'

/**
 * This is the file that proves M4a-2's security property: every tool in CATALOGUE, called with a
 * PersonQuery bound to one person, never answers with a second person's data.
 *
 * It is driven from CATALOGUE rather than a hand-written list of tool names, so a tool added
 * later is covered without anyone remembering to add it here. See TOOL_INPUTS in mcp-fixtures.ts
 * for what happens to a tool CATALOGUE grows that this file was never told how to call.
 *
 * `sql_query` in M4b inherits exactly the binding this file tests: PersonQuery binds a person in
 * its constructor and the module-level readers behind it are deliberately unexported, so a tool
 * (or a query) that forgets a WHERE clause cannot leak another member's data. This file is what
 * makes that a fact about the tool surface rather than a claim about PersonQuery alone.
 */

/**
 * Seeds alice and bart with bare person rows, then hands off to `seedToolData` in
 * mcp-fixtures.ts for everything else the five tool families in CATALOGUE read — the sources, the
 * daily rows, the sample, the four sessions, the two notes and the two events.
 */
function seedTwoPeople(db: TestDatabase['db']): void {
  seedPerson(db, 'alice')
  seedPerson(db, 'bart')
  seedToolData(db)
}

let test: TestDatabase
let alice: PersonQuery
beforeEach(() => {
  test = createTestDatabase()
  seedTwoPeople(test.db)
  alice = new PersonQuery(test.db, 'alice')
})
afterEach(() => test.cleanup())

describe('every tool, bound to one person, proved against a second', () => {
  for (const t of CATALOGUE) {
    it(`${t.name} never answers with another person's data`, () => {
      const input = TOOL_INPUTS[t.name]
      if (input === undefined) {
        throw new Error(
          `no representative input for tool '${t.name}' in TOOL_INPUTS in mcp-fixtures.ts — `
          + "add one rather than letting a tool go uncovered by this file's guarantee",
        )
      }

      const result = t.run(alice, input)
      const json = JSON.stringify(result)
      for (const fingerprint of BART_TEXT_FINGERPRINTS) {
        expect(json).not.toContain(fingerprint)
      }
      for (const fingerprint of BART_NUMBER_FINGERPRINTS) {
        expect(numberLeak(json, fingerprint)).toBeNull()
      }
    })
  }

  // The suite's own floor. Without this, a PersonQuery bound to nobody's rows would answer
  // thirteen empty results, contain none of bart's fingerprints, and pass - which is the one way
  // this file could be green and worthless.
  it("answers with alice's own data, so the absence of bart's means something", () => {
    const missing: string[] = []
    for (const [name, fingerprint] of Object.entries(ALICE_FINGERPRINTS)) {
      const t = CATALOGUE.find((tool) => tool.name === name)
      if (t === undefined) throw new Error(`no tool named ${name}`)
      const result = t.run(alice, TOOL_INPUTS[name]!)
      const json = JSON.stringify(result)
      // A plain substring check here would be the mirror image of the bug master's numberLeak
      // fixes: this is an assertion that a number IS present, so a coincidental match inside a
      // generated hex id would make '1200' or '58' pass even if alice's real value never
      // appeared. Route the numeric fingerprints through the same boundary-anchored matcher,
      // inverted, so this proves the number is really alice's value rather than hex noise.
      const found = /^\d+$/.test(fingerprint) ? numberLeak(json, fingerprint) !== null : json.includes(fingerprint)
      if (!found) {
        missing.push(`${name} did not answer with ${fingerprint}: ${json.slice(0, 300)}`)
      }
    }
    expect(missing).toEqual([])
  })

  // Guards the matcher rather than the tools, the way the fingerprints themselves guard the
  // binding: a matcher relaxed back to includes() would resume reporting leaks that never
  // happened, and a matcher too strict to see a real one would report nothing ever again. The
  // first case below is the exact answer that failed CI, on a commit that leaked nothing.
  it('reads a leaked number without reading the digits inside a generated id', () => {
    const innocent = '{"notes":[{"id":"1162ccd1-58d0-453f-9599-17671dc0c77c",'
      + '"body":{"untrustedText":"alice-note-sentinel"}}]}'
    expect(innocent).toContain('176')
    expect(numberLeak(innocent, '176')).toBeNull()

    // Every JSON position a leaked number can occupy still reads as the leak it is.
    expect(numberLeak('{"heightCm":176}', '176')).not.toBeNull()
    expect(numberLeak('{"v":[176,2]}', '176')).not.toBeNull()
    expect(numberLeak('{"v":"176"}', '176')).not.toBeNull()
    expect(numberLeak('{"v":176.0}', '176')).not.toBeNull()
    expect(numberLeak('{"steps":8800}', '8800')).not.toBeNull()

    // A longer number that merely contains it is a different number, not bart's.
    expect(numberLeak('{"v":21760}', '176')).toBeNull()
  })

  // The catalogue loop above only ever hands a tool one of alice's own ids, which proves what a
  // tool bound to alice answers, never what it refuses. `get_workout` takes a sessionId as a bare
  // string argument rather than something a query narrows by, and ids appear in other tools'
  // output (get_workouts lists them) — a model that has seen bart's session id from somewhere
  // else in a shared household and hands it back is the single most plausible route into another
  // member's data on this surface. This is the file whose job is to make that refusal visible
  // rather than assumed.
  it("get_workout refuses bart's session id under alice's binding, rather than answering with it", () => {
    const getWorkout = CATALOGUE.find((t) => t.name === 'get_workout')
    if (getWorkout === undefined) throw new Error('no tool named get_workout')

    let caught: unknown
    try {
      getWorkout.run(alice, { sessionId: 'bart-run' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ConfigError)
    // The refusal is allowed to echo the id alice herself supplied — she already had it — but
    // must carry nothing else that identifies bart: not his source, not his other session, not
    // either sentinel, not either of his numbers.
    const detail = (caught as ConfigError).detail
    for (const fingerprint of ['bart-watch', 'bart-night', 'bart-note-sentinel', 'bart-event-sentinel', '8800', '176']) {
      expect(detail).not.toContain(fingerprint)
    }
  })
})
