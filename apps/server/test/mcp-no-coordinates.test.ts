import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { eq } from 'drizzle-orm'
import { CATALOGUE } from '../src/mcp/catalogue.ts'
import { TOOL_INPUTS, seedToolData } from './mcp-fixtures.ts'

/**
 * Coordinates are the most identifying thing this project stores: a household's route is where
 * they live. The rule is that a route never reaches an MCP tool response, and until this file the
 * only thing enforcing it was a hand-written object literal in workouts.ts.
 *
 * That is not enforcement. The adapter passes a tool's return value into `structuredContent` and
 * JSON.stringify with no schema stripping, and mcp-contract.test.ts asserts that undeclared keys
 * pass through, deliberately. So adding one line to the projection - the same line tier2.ts
 * already carries - would have leaked every point of every route and turned nothing red. The
 * existing tool tests assert field by field with `toBe`, which is a test of what IS there and says
 * nothing about what else came along.
 *
 * Driven from CATALOGUE rather than a list of tool names, the same way mcp-isolation.test.ts is,
 * so a tool added later is inside this guarantee without anyone remembering to add it.
 */

/** Alice's workout carries a real route. Distinctive enough that a match cannot be coincidence. */
const ROUTE = [
  { ordinal: 0, latitude: 51.925123, longitude: 4.477456 },
  { ordinal: 1, latitude: 51.926234, longitude: 4.478567 },
  { ordinal: 2, latitude: 51.927345, longitude: 4.479678 },
]
const SESSION_WITH_ROUTE = 'alice-run'

/**
 * What a leak looks like in a serialised answer: the coordinate values themselves, and the key
 * names that would carry them. Both, because either alone is escapable - a renamed key still
 * leaks the numbers, and a re-projected number (rounded, or split into a tuple) still leaks the
 * place while no longer matching the literal.
 */
const COORDINATE_KEYS = ['latitude', 'longitude', 'route', 'coordinates', 'polyline']

let test: TestDatabase
let alice: PersonQuery
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'alice')
  seedPerson(test.db, 'bart')
  seedToolData(test.db)
  for (const point of ROUTE) {
    test.db.insert(schema.sessionRoutes).values({
      id: `${SESSION_WITH_ROUTE}-route-${point.ordinal}`,
      sessionId: SESSION_WITH_ROUTE,
      ordinal: point.ordinal,
      atMs: Date.UTC(2026, 7, 1, 9, point.ordinal),
      latitude: point.latitude,
      longitude: point.longitude,
      altitudeMetres: null,
      horizontalAccuracyMetres: null,
      verticalAccuracyMetres: null,
    }).run()
  }
  alice = new PersonQuery(test.db, 'alice')
})
afterEach(() => test.cleanup())

describe('no tool answers with a coordinate', () => {
  for (const t of CATALOGUE) {
    it(`${t.name} carries no part of a route`, async () => {
      const input = TOOL_INPUTS[t.name]
      if (input === undefined) {
        throw new Error(
          `no representative input for tool '${t.name}' in TOOL_INPUTS in mcp-fixtures.ts - `
          + "add one rather than letting a tool go uncovered by this file's guarantee",
        )
      }

      const json = JSON.stringify(await t.run(alice, input))
      for (const point of ROUTE) {
        expect(
          json,
          `${t.name} answered with latitude ${point.latitude}, which is a point on the household's `
          + 'route and says where they were. A route must not reach a tool response: the adapter '
          + 'does not strip undeclared keys, so whatever a tool returns is what an agent is handed.',
        ).not.toContain(String(point.latitude))
        expect(
          json,
          `${t.name} answered with longitude ${point.longitude}, which is a point on the `
          + "household's route and says where they were.",
        ).not.toContain(String(point.longitude))
      }
      for (const key of COORDINATE_KEYS) {
        expect(
          json,
          `${t.name} answered with a '${key}' key. Even carrying no recognisable value today, a `
          + 'coordinate-shaped field on this surface is the leak this file exists to stop.',
        ).not.toContain(`"${key}"`)
      }
    })
  }

  /**
   * The floor, and the reason the absences above mean anything.
   *
   * Every assertion in the loop is an absence, and absences pass for the wrong reason all the
   * time: a route that was never seeded, a session id that does not match, a tool that answered
   * an error object. This asserts the route really is in the database, attached to the very
   * session `get_workout` is pointed at, so the loop above is reading a world where the leak was
   * available to happen.
   */
  it('stored the route it is checking for, on the session the tools are asked about', () => {
    const rows = test.db.select().from(schema.sessionRoutes)
      .where(eq(schema.sessionRoutes.sessionId, SESSION_WITH_ROUTE)).all()
    expect(rows).toHaveLength(ROUTE.length)
    expect(rows.map((row) => row.latitude).sort()).toEqual(ROUTE.map((p) => p.latitude).sort())
    expect(TOOL_INPUTS.get_workout).toEqual({ sessionId: SESSION_WITH_ROUTE })
  })
})
