import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'

// Group C: ovulation-test, moods, symptoms, menstrual-period and irregular-rhythm-notification.
// Groups A, B, F, ECG and food each pin their own declarations; this group had none, which is
// how irregular-rhythm-notification's wrong filterMember (interval.start_time instead of
// interval.civil_start_time - IRN is a session type, not an interval type, so the document's
// {session_data_type}.interval.civil_start_time pattern applies, not
// {interval_data_type}.interval.start_time) shipped and stayed unnoticed: map-observations.
// test.ts hand-built its own DataType literals rather than reading these, so it only ever agreed
// with the mistake rather than catching it.
describe('the catalogue declares Group C', () => {
  it('declares ovulation-test', () => {
    expect(dataTypeById('ovulation-test')).toMatchObject({
      id: 'ovulation-test', scope: 'googlehealth.reproductive_health.readonly',
      filterMember: 'sample_time.physical_time', target: 'observations', metric: '',
    })
  })

  it('declares moods', () => {
    expect(dataTypeById('moods')).toMatchObject({
      id: 'moods', scope: 'googlehealth.mindfulness.readonly',
      filterMember: 'sample_time.physical_time', target: 'observations', metric: '',
    })
  })

  it('declares symptoms', () => {
    expect(dataTypeById('symptoms')).toMatchObject({
      id: 'symptoms', scope: 'googlehealth.logged_symptoms.readonly',
      filterMember: 'sample_time.physical_time', target: 'observations', metric: '',
    })
  })

  it('declares menstrual-period', () => {
    expect(dataTypeById('menstrual-period')).toMatchObject({
      id: 'menstrual-period', scope: 'googlehealth.reproductive_health.readonly',
      filterMember: 'interval.start_time', target: 'observations', metric: '',
    })
  })

  // The entry finding 2 fixed: IRN is a session data type (the discovery document: "Data for
  // points in the irregular-rhythm-notification session data type collection") carrying a
  // SessionTimeInterval, so it takes the session civil-start-time pattern like exercise and
  // hydration-log do - not interval.start_time, which is the interval-type pattern and would
  // 400 every fetch through buildFilter's unsupported-member grammar.
  it('declares irregular-rhythm-notification with the session civil-start-time filter, not the interval-type pattern', () => {
    expect(dataTypeById('irregular-rhythm-notification')).toMatchObject({
      id: 'irregular-rhythm-notification', scope: 'googlehealth.irn.readonly',
      filterMember: 'interval.civil_start_time', target: 'observations', metric: '',
    })
  })
})
