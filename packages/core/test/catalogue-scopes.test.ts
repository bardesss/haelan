import { describe, expect, it } from 'vitest'
import { DATA_TYPES, UNGRANTABLE_SCOPES } from '../src/api/catalogue.ts'
import { SCOPES } from '../src/api/oauth.ts'

const PREFIX = 'https://www.googleapis.com/auth/'

/**
 * Google's OAuth registry, `auth.oauth2.scopes` in the v4 discovery document, read 2026-09-06.
 * Eighteen scopes exist; these eight are every one of them that grants a read of the person's
 * own data. The other ten are `.writeonly`, which Google describes as adding data and editing
 * what the app itself added.
 *
 * Pinned as a literal rather than fetched, because a test that asks the network what the answer
 * is cannot fail when the answer changes underneath it - and this list changing is precisely the
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

  it('requests only scopes Google defines', () => {
    // The shipped defect this catches: googlehealth.nutrition.readonly was requested for a year
    // and is not a scope. Consent did not refuse it, so nothing else could have noticed.
    expect(requested.filter((scope) => REGISTRY_READONLY_SCOPES.includes(scope))).toEqual(requested)
  })

  it('does not request the nutrition scope, which has no readonly form', () => {
    expect(requested.includes('googlehealth.nutrition.readonly')).toBe(false)
  })

  it('requests the ECG and irregular rhythm scopes their data types need', () => {
    expect(requested.includes('googlehealth.ecg.readonly')).toBe(true)
    expect(requested.includes('googlehealth.irn.readonly')).toBe(true)
  })

  it('declares no scope the app neither requests nor records as ungrantable', () => {
    const declared = [...new Set(DATA_TYPES.map((t) => t.scope))].sort()
    const accounted = declared.filter(
      (scope) => requested.includes(scope) || UNGRANTABLE_SCOPES.includes(scope),
    )
    expect(accounted).toEqual(declared)
  })

  it('keeps the ungrantable set to the scopes that measurably have no readonly form', () => {
    // Pinned whole, so the escape hatch above cannot quietly grow. A scope joining this list is a
    // claim that Google offers no way to read the category, which is a measurement, not a guess.
    expect([...UNGRANTABLE_SCOPES]).toEqual(['googlehealth.nutrition.readonly'])
    for (const scope of UNGRANTABLE_SCOPES) {
      expect(REGISTRY_READONLY_SCOPES.includes(scope)).toBe(false)
    }
  })

  it('names which types are unreachable, since the catalogue still lists them', () => {
    // hydration-log and nutrition-log are both under the nutrition category. They are kept in the
    // catalogue rather than deleted: an entry that records why a type cannot be fetched is worth
    // more than its absence, and this pin is what keeps a third one from joining them silently.
    const unreachable = DATA_TYPES
      .filter((t) => UNGRANTABLE_SCOPES.includes(t.scope)).map((t) => t.id).sort()
    expect(unreachable).toEqual(['hydration-log', 'nutrition-log'])
  })
})
