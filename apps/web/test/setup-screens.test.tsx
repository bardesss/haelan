import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { AccountStep } from '../src/setup/AccountStep.js'
import { InstanceUrlStep } from '../src/setup/InstanceUrlStep.js'
import { GoogleStep } from '../src/setup/GoogleStep.js'
import { BackfillStep } from '../src/setup/BackfillStep.js'
import { I18nProvider } from '../src/i18n/index.js'

// Pinned to English: these screens now read their copy from the catalogue, and an
// unpinned instance falls back to navigator.language, which on a Dutch machine would
// render Dutch and break every literal-text assertion below.
const render = (node: ReactElement) => renderToStaticMarkup(<I18nProvider lng="en">{node}</I18nProvider>)

const CANDIDATES = [
  { uri: 'http://localhost:4235/oauth/callback', label: 'This machine', registrable: true },
  { uri: 'http://127.0.0.1:4235/oauth/callback', label: 'This machine, literal loopback', registrable: true },
]

const HORIZON_STATUS = {
  personId: 'p1',
  running: true, reason: 'setup', startedAtMs: 1_770_000_000_000, lastFinishedAtMs: null,
  userHorizonDays: 730,
  backfill: [
    { dataType: 'heart-rate', complete: false, cursorMs: 1_769_000_000_000, horizonDays: 90 },
    { dataType: 'weight', complete: false, cursorMs: 1_769_000_000_000, horizonDays: 730 },
  ],
}

// Colour discipline is not asserted here: no-raw-color.test.ts already walks the whole of
// src/ recursively, so these files are covered by it the moment they exist. A second copy of
// that assertion here would be two tests claiming one fact.

describe('the wizard screens', () => {
  it('never renders a placeholder anywhere a value is meant to be copied', () => {
    const screens = [
      render(<AccountStep onDone={() => {}} />),
      render(<InstanceUrlStep onDone={() => {}} />),
      render(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />),
    ]
    for (const html of screens) {
      // The literal failure this exists to prevent: http://<your-ip>:4235/oauth/callback.
      expect(html).not.toMatch(/&lt;[a-z-]+&gt;/i)
      expect(html).not.toMatch(/your-ip|your-host|example\.com/i)
    }
  })

  it('shows both loopback URIs complete, with the port', () => {
    const html = render(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />)
    expect(html).toContain('http://localhost:4235/oauth/callback')
    expect(html).toContain('http://127.0.0.1:4235/oauth/callback')
  })

  it('marks a rejected candidate as rejected and shows the rule instead of a copy button', () => {
    const html = render(<GoogleStep
      candidates={[...CANDIDATES, {
        uri: 'https://192.168.178.82/oauth/callback', label: 'Reverse proxy or Tailscale',
        registrable: false, reason: 'Hosts cannot be raw IP addresses. Localhost IP addresses are exempted from this rule.',
      }]}
      error={null} onDone={() => {}}
    />)
    expect(html).toContain('Hosts cannot be raw IP addresses')
    expect(html).toContain('data-registrable="false"')
  })

  it('offers a copy control for every registrable URI and none for a rejected one', () => {
    const rejected = {
      uri: 'https://192.168.178.82/oauth/callback', label: 'Reverse proxy or Tailscale',
      registrable: false, reason: 'Hosts cannot be raw IP addresses.',
    }
    const html = render(<GoogleStep
      candidates={[...CANDIDATES, rejected]} error={null} onDone={() => {}}
    />)
    // Two copy buttons, not three: a value Google refuses must not be offered for copying,
    // which is the difference between a wizard that helps and one that wastes a console trip.
    expect(html.match(/data-copy-for=/g)).toHaveLength(2)
    expect(html).not.toContain(`data-copy-for="${rejected.uri}"`)
  })

  it('lists every scope it tells the owner to declare', () => {
    // Found by walking the real console: the copy said "declare all six scopes" and then never
    // said which six, which stops somebody mid setup with no way forward from the screen.
    const scopes = [
      'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
      'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
    ]
    const html = render(
      <GoogleStep candidates={CANDIDATES} scopes={scopes} error={null} onDone={() => {}} />,
    )
    for (const scope of scopes) expect(html).toContain(scope)
  })

  it('counts the scopes it was given rather than claiming a number', () => {
    const html = render(
      <GoogleStep candidates={CANDIDATES} scopes={['a', 'b', 'c']} error={null} onDone={() => {}} />,
    )
    // The instruction has to agree with the list under it. A hard coded "six" beside a list of
    // three is how somebody declares the wrong set and finds out at consent.
    expect(html).toContain('declare the 3 scopes')
    expect(html).not.toMatch(/all six scopes/i)
  })

  it('offers the whole scope list as one copyable value', () => {
    const scopes = ['https://example.invalid/a', 'https://example.invalid/b']
    const html = render(
      <GoogleStep candidates={CANDIDATES} scopes={scopes} error={null} onDone={() => {}} />,
    )
    // Pasting them one at a time into the console is six round trips through this page.
    expect(html).toContain(`data-copy-for="${scopes.join('\n')}"`)
  })

  it('says the unverified app warning is expected, because that is where installs are abandoned', () => {
    const html = render(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />)
    expect(html).toMatch(/unverified/i)
  })

  it('tells the owner to switch publishing to In production, which M0 found is required', () => {
    const html = render(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />)
    expect(html).toContain('In production')
  })

  it('shows the callback error where the owner can act on it', () => {
    const html = render(<GoogleStep
      candidates={CANDIDATES} onDone={() => {}}
      error={{ code: 'exchange_failed', message: 'redirect_uri_mismatch: the redirect URI this instance sent is not registered' }}
    />)
    expect(html).toContain('redirect_uri_mismatch')
    expect(html).toContain('role="alert"')
  })

  it('names every data type it is backfilling and how far back it is going', () => {
    const html = render(<BackfillStep status={{
      personId: 'p1',
      running: true, reason: 'setup', startedAtMs: 1, lastFinishedAtMs: null,
      userHorizonDays: 1825,
      backfill: [
        { dataType: 'heart-rate', complete: false, cursorMs: 1_770_000_000_000, horizonDays: 60 },
        { dataType: 'weight', complete: true, cursorMs: null, horizonDays: 1825 },
      ],
    }} onHorizonChange={() => {}} />)
    expect(html).toContain('heart-rate')
    expect(html).toContain('60')
    expect(html).toContain('weight')
  })

  it('says a finished type is finished rather than showing it as stalled at nothing', () => {
    const html = render(<BackfillStep status={{
      personId: 'p1',
      running: false, reason: null, startedAtMs: null, lastFinishedAtMs: 2,
      userHorizonDays: 1825,
      backfill: [{ dataType: 'weight', complete: true, cursorMs: null, horizonDays: 1825 }],
    }} onHorizonChange={() => {}} />)
    // complete with a null cursor is the finished state, and it must not read as "no progress".
    expect(html).toContain('data-complete="true"')
    expect(html).toMatch(/complete/i)
  })

  it('offers the three horizons with the disk each one costs', () => {
    const html = render(
      <BackfillStep status={HORIZON_STATUS} nowMs={1_770_000_000_000} onHorizonChange={() => {}} />,
    )
    expect(html).toContain('1 year')
    expect(html).toContain('2 years')
    expect(html).toContain('5 years')
    // The figures are the point: they are close together because intraday types are capped, and
    // showing them is what makes that visible instead of asking the reader to trust it.
    expect(html).toContain('1.05 GB')
    expect(html).toContain('1.06 GB')
  })

  it('marks the horizon currently chosen', () => {
    const html = render(
      <BackfillStep status={HORIZON_STATUS} nowMs={1_770_000_000_000} onHorizonChange={() => {}} />,
    )
    expect(html).toContain('data-chosen="true"')
  })

  it('says a capped type is capped rather than letting it read as stalled', () => {
    const html = render(
      <BackfillStep status={HORIZON_STATUS} nowMs={1_770_000_000_000} onHorizonChange={() => {}} />,
    )
    expect(html).toContain('90 days back')
    expect(html).toContain('730 days back')
  })

  it('shows a horizon change that failed, rather than leaving the click looking like nothing happened', () => {
    // A rejected putBackfillHorizon has nowhere else to go: BackfillStep is presentational, so
    // the message has to reach the screen through this prop or it never reaches the screen at all.
    const html = render(
      <BackfillStep
        status={HORIZON_STATUS} nowMs={1_770_000_000_000} onHorizonChange={() => {}}
        failure="days must be one of 365, 730, 1825"
      />,
    )
    expect(html).toContain('days must be one of 365, 730, 1825')
    expect(html).toContain('role="alert"')
  })

  it('does not render "Infinity days" if the backfill list is ever empty', () => {
    // Unreachable through the real setup flow today (a session implies a person, which implies
    // at least one row), but Math.min() of an empty list is Infinity, and a future reordering
    // should not be able to put that literal word on screen.
    const html = render(<BackfillStep status={{
      personId: 'p1',
      running: false, reason: null, startedAtMs: null, lastFinishedAtMs: null,
      userHorizonDays: 730, backfill: [],
    }} nowMs={1_770_000_000_000} onHorizonChange={() => {}} />)
    expect(html).not.toContain('Infinity')
  })

  it('tells the owner the instance URL is not a LAN IP before they try one', () => {
    const html = render(<InstanceUrlStep onDone={() => {}} />)
    expect(html).toMatch(/IP address/i)
  })
})
