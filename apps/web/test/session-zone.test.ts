import { describe, it, expect } from 'vitest'
import { withZoneDefaults } from '../src/auth/session.js'
import type { Session } from '../src/auth/session.js'
import { localToday } from '../src/controls/range.js'

const BASE: Omit<Session, 'effectiveTimezone' | 'currentTimezone' | 'followPhoneZone'> = {
  personId: 'p1', displayName: 'Robin', username: 'robin', isAdmin: false, timezone: 'Europe/Amsterdam',
  birthDate: null, sex: null, sleepTargetMinutes: 480, sleepUseBaseline: true, quickLogEnabled: false,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

describe('the session zone fields', () => {
  it('keeps what a current server sends', () => {
    const session = withZoneDefaults({ ...BASE, effectiveTimezone: 'Asia/Tokyo', currentTimezone: 'Asia/Tokyo', followPhoneZone: true })
    expect(session).toMatchObject({ timezone: 'Europe/Amsterdam', effectiveTimezone: 'Asia/Tokyo', currentTimezone: 'Asia/Tokyo' })
  })

  it('reads an older server, or a demo recorded before the fields, as the home zone', () => {
    expect(withZoneDefaults(BASE)).toMatchObject({
      effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true,
    })
  })

  it('puts today in the effective zone: already the 27th in Tokyo while it is the 26th at home', () => {
    const now = new Date('2026-09-26T20:00:00Z')
    const session = withZoneDefaults({ ...BASE, effectiveTimezone: 'Asia/Tokyo', currentTimezone: 'Asia/Tokyo', followPhoneZone: true })
    expect(localToday(session.effectiveTimezone, now)).toBe('2026-09-27')
    expect(localToday(session.timezone, now)).toBe('2026-09-26')
  })
})
