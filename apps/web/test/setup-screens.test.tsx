import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountStep } from '../src/setup/AccountStep.js'
import { InstanceUrlStep } from '../src/setup/InstanceUrlStep.js'
import { GoogleStep } from '../src/setup/GoogleStep.js'
import { BackfillStep } from '../src/setup/BackfillStep.js'

const CANDIDATES = [
  { uri: 'http://localhost:4235/oauth/callback', label: 'This machine', registrable: true },
  { uri: 'http://127.0.0.1:4235/oauth/callback', label: 'This machine, literal loopback', registrable: true },
]

// Colour discipline is not asserted here: no-raw-color.test.ts already walks the whole of
// src/ recursively, so these files are covered by it the moment they exist. A second copy of
// that assertion here would be two tests claiming one fact.

describe('the wizard screens', () => {
  it('never renders a placeholder anywhere a value is meant to be copied', () => {
    const screens = [
      renderToStaticMarkup(<AccountStep onDone={() => {}} />),
      renderToStaticMarkup(<InstanceUrlStep onDone={() => {}} />),
      renderToStaticMarkup(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />),
    ]
    for (const html of screens) {
      // The literal failure this exists to prevent: http://<your-ip>:4235/oauth/callback.
      expect(html).not.toMatch(/&lt;[a-z-]+&gt;/i)
      expect(html).not.toMatch(/your-ip|your-host|example\.com/i)
    }
  })

  it('shows both loopback URIs complete, with the port', () => {
    const html = renderToStaticMarkup(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />)
    expect(html).toContain('http://localhost:4235/oauth/callback')
    expect(html).toContain('http://127.0.0.1:4235/oauth/callback')
  })

  it('marks a rejected candidate as rejected and shows the rule instead of a copy button', () => {
    const html = renderToStaticMarkup(<GoogleStep
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
    const html = renderToStaticMarkup(<GoogleStep
      candidates={[...CANDIDATES, rejected]} error={null} onDone={() => {}}
    />)
    // Two copy buttons, not three: a value Google refuses must not be offered for copying,
    // which is the difference between a wizard that helps and one that wastes a console trip.
    expect(html.match(/data-copy-for=/g)).toHaveLength(2)
    expect(html).not.toContain(`data-copy-for="${rejected.uri}"`)
  })

  it('says the unverified app warning is expected, because that is where installs are abandoned', () => {
    const html = renderToStaticMarkup(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />)
    expect(html).toMatch(/unverified/i)
  })

  it('tells the owner to switch publishing to In production, which M0 found is required', () => {
    const html = renderToStaticMarkup(<GoogleStep candidates={CANDIDATES} error={null} onDone={() => {}} />)
    expect(html).toContain('In production')
  })

  it('shows the callback error where the owner can act on it', () => {
    const html = renderToStaticMarkup(<GoogleStep
      candidates={CANDIDATES} onDone={() => {}}
      error={{ code: 'exchange_failed', message: 'redirect_uri_mismatch: the redirect URI this instance sent is not registered' }}
    />)
    expect(html).toContain('redirect_uri_mismatch')
    expect(html).toContain('role="alert"')
  })

  it('names every data type it is backfilling and how far back it is going', () => {
    const html = renderToStaticMarkup(<BackfillStep status={{
      running: true, reason: 'setup', startedAtMs: 1, lastFinishedAtMs: null,
      backfill: [
        { dataType: 'heart-rate', complete: false, cursorMs: 1_770_000_000_000, horizonDays: 60 },
        { dataType: 'weight', complete: true, cursorMs: null, horizonDays: 1825 },
      ],
    }} />)
    expect(html).toContain('heart-rate')
    expect(html).toContain('60')
    expect(html).toContain('weight')
  })

  it('says a finished type is finished rather than showing it as stalled at nothing', () => {
    const html = renderToStaticMarkup(<BackfillStep status={{
      running: false, reason: null, startedAtMs: null, lastFinishedAtMs: 2,
      backfill: [{ dataType: 'weight', complete: true, cursorMs: null, horizonDays: 1825 }],
    }} />)
    // complete with a null cursor is the finished state, and it must not read as "no progress".
    expect(html).toContain('data-complete="true"')
    expect(html).toMatch(/complete/i)
  })

  it('tells the owner the instance URL is not a LAN IP before they try one', () => {
    const html = renderToStaticMarkup(<InstanceUrlStep onDone={() => {}} />)
    expect(html).toMatch(/IP address/i)
  })
})
