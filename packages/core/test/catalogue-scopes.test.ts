import { describe, expect, it } from 'vitest'
import { DATA_TYPES, UNGRANTABLE_SCOPES } from '../src/api/catalogue.ts'
import { SCOPES } from '../src/api/oauth.ts'

const PREFIX = 'https://www.googleapis.com/auth/'

/**
 * The readable scopes named by `auth.oauth2.scopes` in the v4 discovery document, read 2026-09-06.
 *
 * **This list is known to be incomplete.** `googlehealth.nutrition.readonly` is absent from it and
 * is nonetheless real: the console's Data Access page lists it with a Google-authored description
 * (probe/findings/scopes.md, 2026-08-19) and hydration-log returned 33 real points under it
 * (probe/findings/field-map.md). So membership here is evidence a scope exists, and absence is
 * evidence of nothing at all. Reasoning in the other direction once removed the nutrition scope
 * from consent, which would have cost every new connection its hydration history.
 *
 * Pinned as a literal rather than fetched, because a test that asks the network what the answer is
 * cannot fail when the answer changes underneath it - and this list changing is precisely the
 * event a person should hear about.
 */
const REGISTRY_READONLY_SCOPES = [
  'googlehealth.activity_and_fitness.readonly',
  'googlehealth.ecg.readonly',
  'googlehealth.health_metrics_and_measurements.readonly',
  'googlehealth.irn.readonly',
  'googlehealth.location.readonly',
  'googlehealth.profile.readonly',
  'googlehealth.settings.readonly',
  'googlehealth.sleep.readonly',
]

/**
 * Scopes the discovery document omits but Google's own console shows, each with the measurement
 * that puts it here. A scope joining this list needs a console observation or a successful fetch,
 * not an inference.
 */
const CONSOLE_OBSERVED_SCOPES = [
  // Data Access page, 2026-08-19, classified Restricted, described "See your Google Health
  // nutrition data". hydration-log then returned 33 points under a token granted from it.
  'googlehealth.nutrition.readonly',
]

// oauth.ts writes the full URL form because that is what the authorization request carries, while
// the catalogue writes the bare name. Comparing the two without saying so is how a catalogue entry
// and a requested scope drifted apart unnoticed in the first place.
const requested = SCOPES.map((scope) => scope.slice(PREFIX.length))

describe('a data type never names a scope consent does not carry', () => {
  it('writes every requested scope in the URL form the comparison below assumes', () => {
    // Without this, a change to the prefix would leave `requested` full of full URLs, no declared
    // scope would ever match one, and the guard below would still pass by way of its own escape
    // hatch being wrong rather than by the property holding.
    expect(SCOPES.filter((scope) => scope.startsWith(PREFIX))).toEqual([...SCOPES])
  })

  it('requests only scopes something has actually observed', () => {
    const evidenced = requested.filter((scope) =>
      REGISTRY_READONLY_SCOPES.includes(scope) || CONSOLE_OBSERVED_SCOPES.includes(scope))
    expect(evidenced).toEqual(requested)
  })

  it('requests the nutrition scope, which the discovery document omits and the console shows', () => {
    // Regression guard, and the only test here that exists because of a specific mistake: this
    // scope was removed on the reasoning that the discovery document does not name it. Removing it
    // costs hydration-log, which is mapped and populated.
    expect(requested.includes('googlehealth.nutrition.readonly')).toBe(true)
  })

  it('requests the ECG and irregular rhythm scopes their data types need', () => {
    expect(requested.includes('googlehealth.ecg.readonly')).toBe(true)
    expect(requested.includes('googlehealth.irn.readonly')).toBe(true)
  })

  it('declares no scope the app neither requests nor records as ungrantable', () => {
    // The guard that matters. A catalogue entry naming a scope nobody asked consent for fetches
    // nothing, and nothing else in the suite would notice.
    const declared = [...new Set(DATA_TYPES.map((t) => t.scope))].sort()
    const accounted = declared.filter(
      (scope) => requested.includes(scope) || UNGRANTABLE_SCOPES.includes(scope),
    )
    expect(accounted).toEqual(declared)
  })

  it('holds nothing in the ungrantable set, so every declared scope is a requested one', () => {
    // Pinned empty rather than deleted. A scope entering this list is a claim that Google offers no
    // way to read a category at all - which has to come from the console or a failed fetch, never
    // from the discovery document's silence, because that silence has already been wrong once.
    expect([...UNGRANTABLE_SCOPES]).toEqual([])
    const unreachable = DATA_TYPES
      .filter((t) => UNGRANTABLE_SCOPES.includes(t.scope)).map((t) => t.id).sort()
    expect(unreachable).toEqual([])
  })
})
