import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import type { RecoveryMethod } from '../src/data/periodTypes.js'
import { HowTheIndexWorks } from '../src/pages/recovery/HowTheIndexWorks.js'

// Every number differs from the shipped constants, so a sentence that typed one in rather than
// reading it from `method` would print the production value and fail here.
const METHOD: RecoveryMethod = {
  weights: { hrv: 0.6, restingHeartRate: 0.25, sleep: 0.1, respiratoryRate: 0.05 },
  usualBand: { low: 30, high: 70 },
  baselineDays: 45,
  stretch: { weekDays: 5, minReadings: 3, band: 0.75, minRun: 4, lookbackDays: 30 },
}

function paragraphs(lng: 'en' | 'nl'): string[] {
  const html = renderToStaticMarkup(<I18nProvider lng={lng}><HowTheIndexWorks method={METHOD} /></I18nProvider>)
  expect(html).not.toContain('<li')
  expect(html).not.toContain('<ul')
  return [...html.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((match) => match[1]!.replaceAll('&#x27;', "'"))
}

describe('HowTheIndexWorks', () => {
  it('words the method from the numbers it is sent', () => {
    const html = renderToStaticMarkup(<I18nProvider lng="en"><HowTheIndexWorks method={METHOD} /></I18nProvider>)
    expect(html).toContain('<h2')
    expect(html).toContain('How the index works')
    expect(paragraphs('en')).toEqual([
      "The recovery index weighs four readings: HRV 60%, resting heart rate 25%, last week's sleep 10% and breathing rate 5%. Each is set against your own previous 45 days.",
      '50 is your usual. A day from 30 to 70 counts as around your usual; below or above that, as below or above it, and further out, as well below or well above it.',
      "The weights are tuned so the index follows the recovery score in the Google Health app, on scores copied from it by hand. It is not Google's number.",
      'HRV against its usual week takes the average of the last 5 days, once it holds at least 3 readings, and sets it against a band reaching 0.75 × the day-to-day spread of your usual to either side. It counts as a stretch once it stays on one side of that band for 4 measured days in a row.',
    ])
  })

  it('says the same in Dutch', () => {
    expect(paragraphs('nl')).toEqual([
      'De herstelindex weegt vier metingen: HRV 60%, rusthartslag 25%, de slaap van afgelopen week 10% en ademhalingsfrequentie 5%. Elk wordt afgezet tegen je eigen 45 dagen ervoor.',
      '50 is je gebruikelijke waarde. Een dag van 30 tot en met 70 ligt rond je gebruikelijke waarde; daaronder of daarboven ligt hij onder of boven gebruikelijk, en verder weg ver onder of ver boven.',
      'De gewichten zijn zo afgesteld dat de index de herstelscore uit de Google Health-app volgt, op scores die er met de hand uit zijn overgenomen. Het is niet het getal van Google.',
      'HRV tegenover je gebruikelijke week neemt het gemiddelde van de laatste 5 dagen, zodra daar minstens 3 metingen in zitten, en zet het af tegen een band die 0,75 × de spreiding van dag tot dag in je gebruikelijke waarde naar beide kanten reikt. Het telt als een reeks zodra het 4 gemeten dagen achter elkaar aan één kant van die band blijft.',
    ])
  })
})
