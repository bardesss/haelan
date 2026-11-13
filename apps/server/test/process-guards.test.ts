import { EventEmitter } from 'node:events'
import { describe, it, expect } from 'vitest'
import { installProcessGuards } from '../src/processGuards.ts'

describe('installProcessGuards', () => {
  it('logs an unhandled rejection instead of letting Node exit on it', () => {
    const target = new EventEmitter()
    const logged: Array<[string, unknown]> = []
    installProcessGuards(target as never, (message, error) => { logged.push([message, error]) })
    const reason = new Error('late write failed')
    target.emit('unhandledRejection', reason, Promise.resolve())
    expect(logged).toEqual([['unhandled rejection', reason]])
    expect(target.listenerCount('unhandledRejection')).toBe(1)
  })
})
