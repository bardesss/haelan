import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { CredentialStore, listBackups, SCOPES } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

describe('GET /api/settings/maintenance', () => {
  it('answers forbidden for a non-admin session', async () => {
    harness = await withServer()
    await harness.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    const token = await harness.signIn('outsider', 'a good long password')

    const response = await harness.app.inject({
      method: 'GET', url: '/api/settings/maintenance',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.kind).toBe('forbidden')
  })

  it('answers the figures for an admin', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await harness.app.inject({
      method: 'GET', url: '/api/settings/maintenance',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    // keep and intervalHours come from ServerDeps, not process.env (see harness.ts's own
    // dataDir/backupKeep/backupIntervalHours) - asserted as the exact numbers the harness set,
    // so a route that quietly started reading HAELAN_BACKUP_KEEP itself would fail this in a
    // suite that never sets that variable.
    expect(body.keep).toBe(7)
    expect(body.intervalHours).toBe(24)
    expect(body.backups).toEqual([])
    // A freshly created instance has no dead space to reclaim and, on any machine this suite
    // runs on, ample room to copy itself - the two conditions vacuumBlocked is not about.
    expect(body.vacuumBlocked).toBe(false)
    expect(typeof body.bloat.fileBytes).toBe('number')
    expect(body.bloat.fileBytes).toBeGreaterThan(0)
    expect(body.bloat.freeFraction).toBe(0)
  })
})

describe('POST /api/settings/maintenance/backup', () => {
  it('creates a file that listBackups then reports, and answers it in the body', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/backup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ran).toBe(true)
    expect(body.name).toMatch(/^haelan-.*\.sqlite$/)
    expect(body.bytes).toBeGreaterThan(0)
    // Same disclosure the GET handler eleven lines above already refuses: the server's absolute
    // filesystem path has no use on a household dashboard and no business leaving this process.
    expect(body.path).toBeUndefined()

    const onDisk = listBackups(harness.app.haelan.dataDir)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0]).toMatchObject({ name: body.name, takenAtMs: body.takenAtMs, bytes: body.bytes })

    // The same file, through the status route rather than the filesystem directly - GET and POST
    // agree on what a backup is because both go through listBackups.
    const status = await harness.app.inject({
      method: 'GET', url: '/api/settings/maintenance',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(status.json().backups).toEqual([{ name: body.name, takenAtMs: body.takenAtMs, bytes: body.bytes }])
  })

  it('answers forbidden for a non-admin session', async () => {
    harness = await withServer()
    await harness.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    const token = await harness.signIn('outsider', 'a good long password')

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/backup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  // README and config.ts both say HAELAN_BACKUP_KEEP=0 turns backups off; the tick already reads
  // it that way (maintenance-tick.test.ts). Before this fix the button ignored the setting
  // entirely, took a copy anyway, and pruneBackups(dir, 0) - which deletes nothing - left an
  // operator who set this specifically to avoid unbounded growth with exactly that.
  it('declines rather than writes a copy when retention is zero', async () => {
    harness = await withServer({ backupKeep: 0 })
    const token = await harness.signIn()

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/backup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ran: false, reason: 'backups_disabled' })
    expect(listBackups(harness.app.haelan.dataDir)).toHaveLength(0)
  })

  // The boot rebuild worker is a real second writer on its own thread, and both maintenance
  // routes are reachable from listen(), which precedes the rebuild - index.ts's own comment used
  // to claim a vacuum could never begin while that worker holds its connection, true only of the
  // boot path. rebuildInFlight is how the route learns the worker might still be running.
  it('declines rather than writes a copy while the boot rebuild worker might still hold the file', async () => {
    harness = await withServer({ rebuildInFlight: () => true })
    const token = await harness.signIn()

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/backup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ran: false, reason: 'rebuild_in_progress' })
    expect(listBackups(harness.app.haelan.dataDir)).toHaveLength(0)
  })

  // The error path this route used to leave to Fastify's default handler, which sends
  // err.message straight back - and a Node fs failure here carries the backup folder's own
  // absolute path. Reproduced by putting a plain file where runBackup's mkdirSync expects to
  // create the backups directory, which is what a corrupted volume or a permissions mistake
  // would also produce: a real, undoctored throw, not a stub told to say something.
  it('answers a bare 500 rather than a filesystem error containing the server\'s own path', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    writeFileSync(join(harness.dir, 'backups'), 'not a directory')

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/backup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(500)
    const raw = response.payload
    expect(raw).not.toContain(harness.dir)
    expect(raw).not.toContain('ENOTDIR')
    expect(raw).not.toContain('EEXIST')
    expect(response.json()).toMatchObject({ error: { kind: 'internal' } })
  })
})

describe('POST /api/settings/maintenance/reclaim', () => {
  it('on a fresh database answers ran: false with a reason, not an error status', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/reclaim',
      headers: { authorization: `Bearer ${token}` },
    })
    // A declined vacuum is a correct outcome, exactly as vacuumIfBloated's own contract says -
    // not a 4xx or 5xx a client would have to unwrap an error envelope to read past.
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ran).toBe(false)
    expect(['below_fraction', 'below_floor']).toContain(body.reason)
    expect(body.bloat).toBeDefined()
  })

  it('answers forbidden for a non-admin session', async () => {
    harness = await withServer()
    await harness.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    const token = await harness.signIn('outsider', 'a good long password')

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/reclaim',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  // See the identical test on the backup route: both are reachable from listen(), which precedes
  // the boot rebuild, so both have to ask rather than assume the worker has finished.
  it('declines rather than vacuum while the boot rebuild worker might still hold the file', async () => {
    harness = await withServer({ rebuildInFlight: () => true })
    const token = await harness.signIn()

    const response = await harness.app.inject({
      method: 'POST', url: '/api/settings/maintenance/reclaim',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ ran: false, reason: 'rebuild_in_progress' })
    expect(body.bloat).toBeDefined()
  })
})

// The second half of this task: a person whose row instance.key cannot open. Simulated the way a
// restored backup actually produces it - the same database, a refresh token sealed under a
// different key than the one this process holds - rather than by corrupting bytes, which would
// prove something about malformed ciphertext instead of about the key that sealed it.
describe('a stored refresh token instance.key cannot decrypt', () => {
  it('is reported as needing to re-consent, distinctly from one who was never connected', async () => {
    harness = await withServer()
    await harness.connectPerson()

    const { db } = harness.app.haelan.instance
    const wrongKeyCredentials = new CredentialStore(db, randomBytes(32))
    wrongKeyCredentials.putRefreshToken({
      personId: 'p1', refreshToken: 'sealed-under-a-key-this-process-does-not-have',
      scopes: [...SCOPES], nowMs: harness.clock.nowMs,
    })

    await harness.addPerson({ id: 'p-never', displayName: 'Never Connected', username: 'never' })

    const unreadableToken = await harness.signIn()
    const unreadableMe = await harness.app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: `Bearer ${unreadableToken}` },
    })
    expect(unreadableMe.json()).toMatchObject({ connected: false, credentialsUnreadable: true })

    const neverToken = await harness.signIn('never', 'a good long password')
    const neverMe = await harness.app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: `Bearer ${neverToken}` },
    })
    expect(neverMe.json()).toMatchObject({ connected: false, credentialsUnreadable: false })
  })
})
