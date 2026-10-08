import { describe, expect, it } from 'vitest'
import { hrvRunSentence } from '../src/mcp/tools/hrvRunWords.ts'

const RUN = { side: 'below', days: 9, capped: false, since: '2026-08-02', sideNights: 7, weekReadings: 7, filledDays: 0 } as const

describe('hrvRunSentence', () => {
  it('words a stretch below, uncapped, with nothing filled', () => {
    expect(hrvRunSentence(RUN)).toBe(
      " HRV's seven-day average has been below its usual for 9 measured days, since 2026-08-02; 7 of the last 7 nightly readings were low.",
    )
  })

  it('words a stretch above as high', () => {
    expect(hrvRunSentence({ ...RUN, side: 'above', sideNights: 5 })).toBe(
      " HRV's seven-day average has been above its usual for 9 measured days, since 2026-08-02; 5 of the last 7 nightly readings were high.",
    )
  })

  it('counts the nightly readings out of those the week holds, not out of seven', () => {
    expect(hrvRunSentence({ ...RUN, sideNights: 4, weekReadings: 5 })).toBe(
      " HRV's seven-day average has been below its usual for 9 measured days, since 2026-08-02; 4 of the last 5 nightly readings were low.",
    )
  })

  it('words a capped stretch as more than 60 days', () => {
    expect(hrvRunSentence({ ...RUN, days: 60, capped: true })).toBe(
      " HRV's seven-day average has been below its usual for more than 60 days; 7 of the last 7 nightly readings were low.",
    )
  })

  it('says one filled day was filled', () => {
    expect(hrvRunSentence({ ...RUN, filledDays: 1 })).toBe(
      " HRV's seven-day average has been below its usual for 9 measured days, since 2026-08-02; 7 of the last 7 nightly readings were low. 1 of those days' HRV was filled from an intraday average, not measured.",
    )
  })

  it('says several filled days were filled', () => {
    expect(hrvRunSentence({ ...RUN, filledDays: 2 })).toBe(
      " HRV's seven-day average has been below its usual for 9 measured days, since 2026-08-02; 7 of the last 7 nightly readings were low. 2 of those days' HRV were filled from an intraday average, not measured.",
    )
  })
})
