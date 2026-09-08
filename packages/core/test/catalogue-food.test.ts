import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'
import { mapSamples } from '../src/api/mapSamples.ts'
import { body } from '../src/testing/payloads.ts'

const ctx = { personId: 'p1', resolveSource: () => 'watch', rawPayloadId: 'raw1' }
const NUTRITION_SCOPE = 'googlehealth.nutrition.readonly'

// food replaces the group D the spec described, which named the wrong type: Food carries no time
// field at all - no sampleTime, no interval - so it cannot map to samples the way the spec
// assumed. See catalogue.ts's own comment on the entry and
// .superpowers/sdd/2026-09-06-catalogue-catches-up/api-schemas.md for the measured schema.
describe('the catalogue declares food', () => {
  it('declares food, but schedules no fetch and maps nothing: it has no clock', () => {
    const dt = dataTypeById('food')!
    // Asserted whole rather than over a loose subset, the same discipline commit 748a0ab added
    // to groups A and B after scope turned out to be the one field nothing checked. actions and
    // mappingDeferred are the two fields a later edit is most likely to quietly "fix" back toward
    // the group D the spec described - actions to ['list'] on the reasoning food is listable data
    // (which it is, just not through this codebase's windowed fetch), mappingDeferred to
    // undefined once a valuePath looks pickable. Neither edit would be reachable: there is still
    // no field to build a list window from, and still no clock to hang a row on.
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      target: dt.target, metric: dt.metric, unit: dt.unit, valuePath: dt.valuePath,
      actions: dt.actions, mappingDeferred: dt.mappingDeferred,
    }).toEqual({
      id: 'food', payloadKey: 'food', filterMember: null, scope: NUTRITION_SCOPE,
      target: 'samples', metric: 'food', unit: 'kcal', valuePath: '',
      actions: [], mappingDeferred: true,
    })
  })

  it('maps a schema-shaped Food payload to no rows at all', () => {
    // Built from api-schemas.md's Food entry directly, not from samplePoint/intervalPoint -
    // those helpers each inject a clock (sampleTime or interval), and the whole point here is a
    // payload that never had one to begin with. Every field Food actually carries is present:
    // displayName, brand, accessLevel, servings, nutrients and the three energy figures.
    const payload = {
      dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
      food: {
        displayName: 'Banana, raw',
        brand: '',
        accessLevel: 'FOOD_ACCESS_LEVEL_PUBLIC',
        mealType: 'SNACK',
        languageCode: 'en',
        servings: [{ amount: 1, unit: 'MEDIUM' }],
        nutrients: [
          { nutrient: 'POTASSIUM', quantity: { grams: 0.422, userProvidedUnit: 'GRAM' } },
          { nutrient: 'SUGAR', quantity: { grams: 14.4, userProvidedUnit: 'GRAM' } },
        ],
        totalFat: { grams: 0.3, userProvidedUnit: 'GRAM' },
        totalCarbohydrate: { grams: 27, userProvidedUnit: 'GRAM' },
        energyAvg: { kcal: 105, userProvidedUnit: 'KILOCALORIE' },
        energyMin: { kcal: 90, userProvidedUnit: 'KILOCALORIE' },
        energyMax: { kcal: 120, userProvidedUnit: 'KILOCALORIE' },
      },
    }
    const rows = mapSamples({ dataType: dataTypeById('food')!, body: body([payload]), ...ctx })
    // The count is the assertion that matters: []  is the behaviour mapSamples already guarantees
    // for any mappingDeferred type (map-samples.test.ts's own generic loop covers food the moment
    // it is declared deferred), and pinning it here as a count is what stops a later edit from
    // quietly un-deferring a type that still has nowhere to put a date.
    expect(rows).toHaveLength(0)
  })
})

describe('nutrition-log stays deferred', () => {
  // Verification, not a change: the entry was already correct before this task. Its valuePath was
  // corrected from an invented 'calories' to the measured 'energy.kcal' when the scope was added,
  // and mapping stays deferred for a different reason than food - the payload also carries
  // nutrients[], totalFat and totalCarbohydrate, so a single kcal column answers less than the
  // type holds, and the household has logged no food at all for a fuller mapping to be designed
  // against. That second reason is temporary; food's is not.
  it('still reads energy.kcal and is still mappingDeferred', () => {
    const dt = dataTypeById('nutrition-log')!
    expect(dt.valuePath).toBe('energy.kcal')
    expect(dt.mappingDeferred).toBe(true)
  })
})
