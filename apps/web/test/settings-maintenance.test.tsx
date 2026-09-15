// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Settings } from '../src/pages/Settings.js'
import { Maintenance } from '../src/pages/settings/Maintenance.js'
import { maintenanceKey } from '../src/data/useMaintenance.js'
import type { BackupOutcome, MaintenanceStatus, VacuumOutcome } from '../src/data/useMaintenance.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import { membersKey } from '../src/data/useMembers.js'
import { instanceUrlKey } from '../src/data/useInstanceUrl.js'
import { flush } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const ADMIN: Session = {
  personId: 'admin-1', displayName: 'Admin', username: 'admin', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

// Every field MaintenanceStatus needs, defaulted so a test only names what it is actually
// asserting on -- the same reason settings-members.test.tsx's own member() helper takes overrides
// rather than every test spelling out the whole shape.
function status(overrides: Partial<MaintenanceStatus>): MaintenanceStatus {
  return {
    bloat: { fileBytes: 200_000_000, liveBytes: 150_000_000, freeBytes: 50_000_000, freeFraction: 0.25 },
    backups: [],
    keep: 7,
    intervalHours: 24,
    vacuumBlocked: false,
    ...overrides,
  }
}

/**
 * Mounts the Maintenance section alone, with the status pre-seeded under the same key
 * useMaintenanceStatus and both mutations' own invalidation share (maintenanceKey). An unseeded
 * query would reach the real network in this environment rather than merely running slow -- see
 * apps/web/test/control-row.test.tsx's own comment on withQuery -- so every test here seeds it.
 */
function mountSection(data: MaintenanceStatus): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), ADMIN)
  client.setQueryData(maintenanceKey(), data)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Maintenance /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

/**
 * Mounts the whole Settings page as a given session, the way a real admin or a real non-admin
 * member would see it -- settings-members.test.tsx's own mountSettingsAs, extended with the keys
 * Maintenance.tsx and InstanceUrl.tsx also read. OverrideList, SourceNames, Members and
 * InstanceUrl mount alongside it here regardless of which section this test cares about, so every
 * one of their queries needs seeding too or they reach the real network the same way an unseeded
 * maintenance query would.
 */
function mountSettingsAs(overrides: Partial<Session>): void {
  const session: Session = { ...ADMIN, ...overrides }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), session)
  client.setQueryData(sourceNamesKey(session.personId), { items: [] })
  client.setQueryData(queryKeys.resource(session.personId, 'overrides'), { items: [] })
  client.setQueryData(membersKey(), { items: [] })
  client.setQueryData(maintenanceKey(), status({}))
  client.setQueryData(instanceUrlKey(), { baseUrl: 'http://localhost:4235', redirectUri: 'http://localhost:4235/oauth/callback' })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Settings /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const RESTORE_DETAIL = "Your health data is safe and still here. This instance just can't read the Google credentials it has on file - that's what happens when a database is restored without the instance.key file that encrypted them. It also cost the household's Google client secret, and the instance has already written itself a new instance.key. Connect again to fix it."

const text = (selector: string): string => container!.querySelector(selector)?.textContent ?? ''

// Scoped to the card's own action row rather than every .form-actions in the tree: the backup
// schedule form below the retention line carries one of its own, and an unscoped selector would
// put its Save button first in this list and hand it to every click() below.
const cardButtons = (): HTMLButtonElement[] =>
  [...container!.querySelectorAll<HTMLButtonElement>('.maintenance > .form-actions button')]

const buttonLabels = (): string[] => cardButtons().map((b) => b.textContent ?? '')

/**
 * Stands in for the two POST routes (apps/server/src/routes/maintenance.ts): backup answers
 * whatever `backupResult` names, reclaim answers whatever `reclaimResult` names. Neither takes a
 * request body, so unlike mockSourcesApi/mockMembersApi there is no body to branch on -- only the
 * path tells the two apart.
 */
function mockMaintenanceApi(backupResult: BackupOutcome, reclaimResult: VacuumOutcome): {
  restore: () => void
  requests: { method: string, url: string }[]
} {
  const requests: { method: string, url: string }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ method, url })
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    if (method === 'POST' && url.endsWith('/api/settings/maintenance/backup')) return json(backupResult)
    if (method === 'POST' && url.endsWith('/api/settings/maintenance/reclaim')) return json(reclaimResult)
    if (method === 'GET' && url.endsWith('/api/settings/maintenance')) return json(status({}))
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requests }
}

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

// A controlled number input: React listens on the bubbling 'input' event, and setting .value
// directly bypasses its own value tracker, so the setter has to be reached through the prototype
// the way every other controlled-input test in this suite does.
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the maintenance section', () => {
  it('shows the dead space in MB, not the raw byte count', () => {
    mountSection(status({ bloat: { fileBytes: 210_000_000, liveBytes: 157_700_000, freeBytes: 52_300_000, freeFraction: 0.249 } }))
    // The exact string, not a substring: toContain('52.3') would also pass on a regression that
    // dropped the trailing zero a different figure happens to need, the same gap
    // substring-assertions-hide-format-regressions calls out.
    expect(text('.maintenance-bloat')).toBe('52.3 MB of dead space in the database file.')
    expect(text('.maintenance-bloat')).not.toContain('52300000')
  })

  it('shows the last backup as a date a person recognises, not its raw timestamp', () => {
    const takenAtMs = Date.UTC(2026, 0, 2, 3, 4, 5)
    mountSection(status({
      backups: [{ name: 'haelan-2026-01-02T03-04-05-000Z.sqlite', takenAtMs, bytes: 10_500_000 }],
    }))
    // The exact same Intl call the component makes, not a hand rolled expectation: locale
    // formatting is an ICU detail this test has no business re-implementing (override-list.test.tsx's
    // own comment on its date assertion says the same).
    const expectedDate = new Date(takenAtMs).toLocaleString('en', { dateStyle: 'medium' })
    expect(text('.maintenance-backups')).toBe(`Last backup ${expectedDate} (10.5 MB).`)
    expect(text('.maintenance-backups')).not.toContain(String(takenAtMs))
  })

  it('says so when there are no backups yet', () => {
    mountSection(status({ backups: [] }))
    expect(text('.maintenance-backups')).toBe('No backups yet.')
  })

  it('offers a download link pointing at the latest backup by name', () => {
    mountSection(status({
      backups: [{ name: 'haelan-2026-01-02T03-04-05-000Z.sqlite', takenAtMs: Date.UTC(2026, 0, 2), bytes: 10_500_000 }],
    }))
    const link = container!.querySelector<HTMLAnchorElement>('.maintenance-download')
    // getAttribute, not .href: happy-dom resolves the property against the document's base URL,
    // so a component that emitted an absolute URL to another origin would still pass a check on
    // the property while failing the one thing this assertion is about.
    expect(link?.getAttribute('href')).toBe(
      '/api/settings/maintenance/backups/haelan-2026-01-02T03-04-05-000Z.sqlite/download',
    )
    expect(link?.textContent).toBe('Download backup')
  })

  // Not a warning, a restore fact: the README says a backup does not contain instance.key, and
  // somebody downloading one has to know that the file alone will not bring the stored Google
  // credentials back.
  it('says the downloaded file does not carry instance.key', () => {
    mountSection(status({
      backups: [{ name: 'haelan-2026-01-02T03-04-05-000Z.sqlite', takenAtMs: Date.UTC(2026, 0, 2), bytes: 10_500_000 }],
    }))
    expect(text('.maintenance-download-note')).toBe(
      'The file holds the database only. instance.key stays here, and is needed to read the stored Google credentials back.',
    )
  })

  it('offers no download link when there are no backups yet', () => {
    mountSection(status({ backups: [] }))
    expect(container!.querySelector('.maintenance-download')).toBeNull()
  })

  it('states the retention settings', () => {
    mountSection(status({ keep: 5, intervalHours: 12 }))
    expect(text('.maintenance-retention')).toBe('Keeps the last 5, taken every 12 hours.')
  })

  it('offers both buttons to an admin', () => {
    mountSection(status({}))
    expect(buttonLabels()).toEqual(['Back up now', 'Reclaim space'])
  })

  // Retention set to zero means backups are off everywhere in the code (backupDecision declines
  // every write); the screen used to render "Keeps the last 0, taken every 24 hours" -- a
  // schedule that does not exist -- and leave Back up now enabled, so the only way to learn
  // backups were off was to press it and read the decline.
  it('says backups are switched off, and does not offer a button that will decline, when retention is zero', () => {
    mountSection(status({ keep: 0, intervalHours: 24 }))
    expect(text('.maintenance-retention')).toBe('Backups are switched off for this instance.')
    expect(text('.maintenance-retention')).not.toContain('Keeps the last 0')
    expect(buttonLabels()).toEqual(['Reclaim space'])
  })

  it('is not rendered at all, buttons included, for a non-admin', () => {
    mountSettingsAs({ isAdmin: false })
    expect(container!.querySelector('.maintenance')).toBeNull()
    expect(container!.textContent).not.toContain('Back up now')
    expect(container!.textContent).not.toContain('Reclaim space')
  })

  it('is rendered for an admin', () => {
    mountSettingsAs({ isAdmin: true })
    expect(container!.querySelector('.maintenance')).not.toBeNull()
  })

  it('reports the filename and size once a backup finishes', async () => {
    const api = mockMaintenanceApi(
      { ran: true, name: 'haelan-2026-03-01T00-00-00-000Z.sqlite', takenAtMs: Date.UTC(2026, 2, 1), bytes: 8_200_000 },
      { ran: false, reason: 'below_fraction', bloat: status({}).bloat },
    )
    const client = mountSection(status({}))

    click(cardButtons()[0]!)
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(api.requests.some((r) => r.method === 'POST' && r.url.endsWith('/backup'))).toBe(true)
    expect(text('.maintenance-backup-result')).toBe('Saved haelan-2026-03-01T00-00-00-000Z.sqlite (8.2 MB).')
  })

  it('reports how much was reclaimed when the vacuum ran', async () => {
    const api = mockMaintenanceApi(
      { ran: true, name: 'unused.sqlite', takenAtMs: 0, bytes: 0 },
      {
        ran: true,
        before: status({}).bloat,
        after: { fileBytes: 150_000_000, liveBytes: 150_000_000, freeBytes: 0, freeFraction: 0 },
        reclaimedBytes: 50_300_000,
        ms: 1500,
        checkpointed: true,
      },
    )
    const client = mountSection(status({}))

    const reclaimButton = cardButtons()[1]!
    click(reclaimButton)
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(text('.maintenance-reclaim-result')).toBe('Reclaimed 50.3 MB.')
  })

  // checkpointed: false means the truncate that would actually shrink the file was busy behind a
  // reader -- the vacuum itself still committed, so this must not read the same as a clean
  // reclaim (finding 1's own shape: something reporting success while the bytes are still on
  // disk) or as a failure (the pages are genuinely free; the next checkpoint takes them).
  it('says the reclaim has not left the file yet when the checkpoint was busy, rather than reporting it as done', async () => {
    const api = mockMaintenanceApi(
      { ran: true, name: 'unused.sqlite', takenAtMs: 0, bytes: 0 },
      {
        ran: true,
        before: status({}).bloat,
        after: { fileBytes: 200_000_000, liveBytes: 150_000_000, freeBytes: 0, freeFraction: 0 },
        reclaimedBytes: 50_300_000,
        ms: 1500,
        checkpointed: false,
      },
    )
    const client = mountSection(status({}))

    const reclaimButton = cardButtons()[1]!
    click(reclaimButton)
    await flush(client, () => container!.innerHTML)
    api.restore()

    const message = text('.maintenance-reclaim-result')
    expect(message).not.toBe('Reclaimed 50.3 MB.')
    expect(message).toBe(
      'Reclaimed 50.3 MB, but another connection was mid-read; it will leave the file once the next checkpoint can run.',
    )
  })

  // The one behaviour this whole task exists to get right: not_enough_disk is the reason a
  // household can actually do something about, so it is the one the route hands back raw
  // (maintenance-routes.test.ts's own body.reason assertions) and the one this component must
  // turn into a sentence rather than pass through.
  it('shows an actionable sentence, not the bare enum, when a reclaim is declined for lack of disk', async () => {
    const api = mockMaintenanceApi(
      { ran: true, name: 'unused.sqlite', takenAtMs: 0, bytes: 0 },
      { ran: false, reason: 'not_enough_disk', bloat: status({}).bloat },
    )
    const client = mountSection(status({}))

    const reclaimButton = cardButtons()[1]!
    click(reclaimButton)
    await flush(client, () => container!.innerHTML)
    api.restore()

    const message = text('.maintenance-reclaim-result')
    expect(message).not.toBe('not_enough_disk')
    expect(message).not.toContain('not_enough_disk')
    expect(message).toBe(
      'There is not enough free disk to safely reclaim space right now. Free up some disk space and try again.',
    )
  })

  it('names the same lack-of-disk sentence up front when the status already says a vacuum would decline', () => {
    mountSection(status({ vacuumBlocked: true }))
    expect(text('.maintenance-blocked')).toBe(
      'There is not enough free disk to safely reclaim space right now. Free up some disk space and try again.',
    )
  })

  // The backup button's own decline, now that the route can answer one (retention set to zero):
  // an actionable sentence rather than the bare enum, the same standard the reclaim decline above
  // is held to.
  it('shows an actionable sentence, not the bare enum, when a backup is declined because retention is off', async () => {
    const api = mockMaintenanceApi(
      { ran: false, reason: 'backups_disabled' },
      { ran: false, reason: 'below_fraction', bloat: status({}).bloat },
    )
    const client = mountSection(status({}))

    click(cardButtons()[0]!)
    await flush(client, () => container!.innerHTML)
    api.restore()

    const message = text('.maintenance-backup-result')
    expect(message).not.toBe('backups_disabled')
    expect(message).not.toContain('backups_disabled')
    expect(message).toBe('Backups are turned off for this instance.')
  })
  // The spec's second half: M5d-B/C put this explanation on the connect card, and someone who
  // restored a backup without their instance.key is most likely in Settings - on the section about
  // backups - when they find out. It shipped with nothing rendering it in a test.
  //
  // Asserted against the wording itself rather than against t('connect.restoreDetail'), which would
  // compare i18next to itself and pass just as happily if the referenced key vanished and both
  // sides resolved to the raw key. The literal below is a second, independent record of what the
  // reader sees, and it is what proves the $t() nesting resolved rather than rendering its own
  // source. If this fails because the copy changed on purpose, update it; if it fails showing
  // "$t(connect.restoreDetail)", the nesting broke.
  it('says the credentials cannot be read, in the same words the connect card uses', () => {
    mountSettingsAs({ credentialsUnreadable: true })
    expect(text('.maintenance-credentials')).toBe(RESTORE_DETAIL)
  })

  it('says nothing about credentials when they can be read', () => {
    mountSettingsAs({ credentialsUnreadable: false })
    expect(text('.maintenance-credentials')).toBe('')
  })
})

/**
 * The backup schedule, which was HAELAN_BACKUP_KEEP and HAELAN_BACKUP_INTERVAL_HOURS until issue
 * 150 moved both onto the settings row. One form, one button, both numbers: the server writes
 * them together because null in either column is what the one-time environment seed reads as
 * "nobody has chosen yet", so half a policy is a policy a leftover variable can still overwrite.
 */
describe('the backup schedule form', () => {
  const fields = (): HTMLInputElement[] =>
    [...container!.querySelectorAll<HTMLInputElement>('.maintenance-policy input')]
  const saveButton = (): HTMLButtonElement =>
    container!.querySelector<HTMLButtonElement>('.maintenance-policy button')!

  it('shows the numbers this instance actually has, not a hardcoded default', () => {
    mountSection(status({ keep: 3, intervalHours: 12 }))
    expect(fields().map((f) => f.value)).toEqual(['3', '12'])
  })

  it('offers nothing to save until a number actually changes', () => {
    mountSection(status({ keep: 7, intervalHours: 24 }))
    expect(saveButton().disabled).toBe(true)
    type(fields()[0]!, '3')
    expect(saveButton().disabled).toBe(false)
  })

  // An empty field is a legitimate state mid-edit, not a zero. Submitting it would send NaN, which
  // the route rejects, so the button refuses it here instead of spending a round trip on it.
  it('refuses to submit a field the reader has emptied', () => {
    mountSection(status({ keep: 7, intervalHours: 24 }))
    type(fields()[0]!, '')
    expect(saveButton().disabled).toBe(true)
  })

  it('sends both numbers in one request and says the save landed', async () => {
    const requests: { method: string, url: string, body: unknown }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
      const payload = method === 'GET' ? status({ keep: 3, intervalHours: 12 }) : { keep: 3, intervalHours: 12 }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const client = mountSection(status({ keep: 7, intervalHours: 24 }))
    type(fields()[0]!, '3')
    type(fields()[1]!, '12')
    click(saveButton())
    await flush(client, () => container!.innerHTML)
    globalThis.fetch = original

    expect(requests).toContainEqual({
      method: 'PUT',
      url: '/api/settings/maintenance/backup-policy',
      body: { keep: 3, intervalHours: 12 },
    })
    expect(text('.maintenance-policy-result')).toBe('Saved. The schedule follows it from the next check.')
  })

  // The server's own message, not a sentence of this panel's: a refused number comes back naming
  // the bound it missed, and that is the only thing telling the reader what to type instead.
  it('shows the reason the server gave when a number is refused', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { kind: 'config', code: 'config', message: 'backups to keep must be a whole number from 0 to 365, got 400' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

    const client = mountSection(status({ keep: 7, intervalHours: 24 }))
    type(fields()[0]!, '400')
    click(saveButton())
    await flush(client, () => container!.innerHTML)
    globalThis.fetch = original

    expect(text('.maintenance-policy-error')).toBe(
      'That did not save: backups to keep must be a whole number from 0 to 365, got 400',
    )
  })
})
