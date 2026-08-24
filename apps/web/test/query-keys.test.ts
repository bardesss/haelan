import { describe, it, expect } from 'vitest'
import { queryKeys } from '../src/api/queryKeys.js'

describe('query keys', () => {
  // Person first, so invalidating a person invalidates everything of theirs and nothing of
  // anybody else's. Section 15 isolation is a server guarantee; this is the cache not undoing it.
  it('puts the person first, so one person can be invalidated whole', () => {
    expect(queryKeys.resource('p1', 'series', { metric: 'steps' })[0]).toBe('person')
    expect(queryKeys.resource('p1', 'series', { metric: 'steps' })[1]).toBe('p1')
  })

  it('is stable against parameter ordering, so two equal queries share one cache entry', () => {
    expect(queryKeys.resource('p1', 'series', { metric: 'steps', agg: 'sum' }))
      .toEqual(queryKeys.resource('p1', 'series', { agg: 'sum', metric: 'steps' }))
  })

  it('separates resources of the same person', () => {
    expect(queryKeys.resource('p1', 'series')).not.toEqual(queryKeys.resource('p1', 'sleep'))
  })

  it('prefixes with the person key, so an invalidate by person matches every resource', () => {
    const person = queryKeys.person('p1')
    const resource = queryKeys.resource('p1', 'series')
    expect(resource.slice(0, person.length)).toEqual(person)
  })

  // Who is signed in is not a fact about a person, it is what tells us which person. Filing it
  // under a person id would mean inventing one before the answer is known.
  it('keeps the session outside the person namespace', () => {
    expect(queryKeys.session()[0]).not.toBe('person')
  })
})
