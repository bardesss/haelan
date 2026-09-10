// Seeds a fresh data directory with a year of plausible demo data, so an instance can be booted
// against it and looked at - either by a household kicking the tyres or by the next unit taking
// README screenshots. A rebuild follows the seed in the same run, because a directory holding
// only `raw_payloads` boots to an empty dashboard until something derives from it, and there is
// no reason to make whoever runs this wait for the next boot to find that out.
//
// It also leaves the wizard already finished, bound to the person it just seeded. The setup
// wizard mints its own person on first boot and asks for a real Google OAuth client; left to that,
// the household member who signs in owns none of the data this script just wrote, and getting from
// a seeded directory to a browsable dashboard means either running the whole wizard against a fake
// client (which cannot finish, since consent is a real redirect to Google) or reaching into the
// stores by hand. Three implementers have now done the latter, each writing their own throwaway
// script for it. completeSetup in apps/server/test/harness.ts already does this shape honestly for
// tests - PeopleStore.create, AccountStore.create, SettingsStore.put, markSetupComplete - and the
// block below follows it, so a fourth bypass never gets invented.
//
// A script rather than a test, deliberately: the same reason check-enum-drift.mjs gives for
// itself, adapted - this writes real files to a real directory, which is not what a test suite's
// temp-and-delete discipline is for. It answers "give me something to look at", not a question
// about the code.
//
// Usage: node --experimental-strip-types scripts/seed-demo.mjs <dir> [days]

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const { DATABASE_FILENAME } = await import('../packages/core/src/db/open.ts')

const [, , dirArg, daysArg] = process.argv
if (!dirArg) {
  console.error('usage: node --experimental-strip-types scripts/seed-demo.mjs <dir> [days]')
  process.exit(1)
}

const days = daysArg === undefined ? 365 : Number(daysArg)
if (!Number.isInteger(days) || days <= 0) {
  console.error(`days must be a positive whole number, got ${daysArg}`)
  process.exit(1)
}

const dir = resolve(dirArg)

// The one rule this script cannot break. There is no undo for a demo seed written over a real
// instance, and the intraday history it would overwrite cannot be re-fetched: the API only keeps
// a recent window of it. Checked before anything in this directory is touched at all - before
// openHaelan, which would otherwise open the very file this guards against overwriting.
const dbPath = join(dir, DATABASE_FILENAME)
if (existsSync(dbPath)) {
  console.error(`refusing to seed ${dir}: ${dbPath} already exists. Point this at an empty directory.`)
  process.exit(1)
}

const { openHaelan } = await import('../packages/core/src/instance.ts')
const { seedPerson } = await import('../packages/core/src/testing/fixtures.ts')
const { seedArchive, localMidnightMs } = await import('../packages/core/src/testing/seed.ts')
const { runRebuild } = await import('../packages/core/src/rebuild/runRebuild.ts')
const { PeopleStore } = await import('../packages/core/src/store/people.ts')
const { AccountStore } = await import('../packages/core/src/store/accounts.ts')
const { SCOPES } = await import('../packages/core/src/api/oauth.ts')

const PERSON_ID = 'demo'
const USERNAME = 'demo'
// A known password, printed below and said again wherever the README points at this script.
// Correct for a directory this script itself refuses to write over an existing database (see the
// refusal above) - wrong for anything this script did not just create.
const PASSWORD = 'haelan-demo'

// Anchored, not "today". Spec section 3 requires a screenshot regenerated next month to show the
// same chart, and the fixed PRNG below only guarantees that if the calendar window it draws over
// is fixed too - weekday alignment (isSunday in seed.ts) moves against a fixed draw sequence
// whenever the end date moves, so "always looks current" and "reproducible" cannot both hold.
// This is the ruling: reproducible wins, since it is what the spec actually asked for.
const DEMO_END_DATE = '2026-09-07'
// Local midnight, not UTC midnight: seedArchive generates in UTC-day chunks, and a UTC-midnight
// endMs lets the last chunk straddle Amsterdam's own day boundary, spilling an hour or two past it
// into a new local day that nothing after endMs ever fills back in - the demo's most recent bar,
// reading nearly empty on Activity and the Dashboard, which is exactly the right-hand edge a
// stranger's eye lands on first. localMidnightMs closes the span on a completed local day instead,
// so there is nothing left on the far side of it to spill into. See its own comment in seed.ts.
const endMs = localMidnightMs(DEMO_END_DATE)

const instance = openHaelan(dir)
try {
  const nowMs = Date.now()

  // seedPerson, not PeopleStore.create: it leaves the built-version stamps unset, which is what
  // marks this person as needing the rebuild below. A person stamped at the current versions
  // from birth would have nothing for runRebuild to pick up.
  seedPerson(instance.db, PERSON_ID, { displayName: 'Demo' })

  const seeded = seedArchive({ archive: instance.archive, personId: PERSON_ID, days, endMs })

  const report = runRebuild({
    db: instance.db,
    archive: instance.archive,
    peopleStore: new PeopleStore(instance.db),
    priority: instance.sourcePriority,
    overrides: instance.overrides,
    settings: instance.settings,
    nowMs,
  })

  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(`rebuild failed for ${failure.personId}:`, failure.error)
    process.exit(1)
  }

  const built = report.people[0]
  console.log(`wrote ${seeded.payloads} payloads, ${days} days, person '${PERSON_ID}', into ${dir}`)
  if (built) {
    console.log(`rebuilt: ${built.samples} samples, ${built.dailyRows} daily rows, `
      + `${built.sessions} sessions, ${built.observations} observations`)
  } else {
    // Would mean the fresh person seedPerson just inserted was not seen as needing a rebuild -
    // a real gap in this script's own premise, not a quiet success.
    console.error('runRebuild did not rebuild the person this script just seeded')
    process.exit(1)
  }

  // What a finished wizard would have left behind, bound to PERSON_ID rather than to a person of
  // the wizard's own minting. Same shape as completeSetup in apps/server/test/harness.ts, for the
  // same reason: PeopleStore.create there (not called here - seedPerson above already made the
  // person row) stamps current versions, AccountStore.create makes someone who can sign in and own
  // it, SettingsStore.put and markSetupComplete are what setupStep in settings.ts reads to decide
  // the wizard is done.
  await new AccountStore(instance.db).create({
    id: `${PERSON_ID}-account`, personId: PERSON_ID, username: USERNAME, password: PASSWORD,
    isAdmin: true, nowMs,
  })
  // The operator's own port, not this script's guess at it. A baseUrl naming a port the server is
  // not listening on is the redirect-URI mismatch the wizard exists to warn about, arriving by way
  // of the demo instead.
  const port = process.env.HAELAN_PORT ?? '4235'
  instance.settings.put({ baseUrl: `http://localhost:${port}`, consentPath: 'localhost', nowMs })
  // A client nobody at Google issued. setupStep only checks that a client is on file, not that
  // Google accepts it (see its own comment in settings.ts), and this script's whole point is an
  // instance nobody needs a Google Cloud project to look at.
  instance.credentials.putClient({
    clientId: 'demo.apps.googleusercontent.com', clientSecret: 'not-a-real-secret', nowMs,
  })
  // A refresh token this instance can decrypt but Google never issued, so the dashboard opens
  // straight onto the data below rather than on ConnectGoogle.tsx's "connect your Google account"
  // card - which would otherwise sit above every one of this data's own screenshots, and reads as
  // exactly the kind of broken a stranger's eye catches first. The sync runner still tries this
  // token against the real token endpoint once on boot and fails there, the same failure a revoked
  // grant produces; nothing it wrote is at risk from that, since a sync only ever reads from
  // Google, never rewrites what seedArchive already put on disk.
  instance.credentials.putRefreshToken({
    personId: PERSON_ID, refreshToken: 'seed-demo-does-not-talk-to-google', scopes: [...SCOPES], nowMs,
  })
  instance.settings.markSetupComplete(nowMs)

  console.log(`setup complete: sign in at http://localhost:${port} with username '${USERNAME}' and `
    + `password '${PASSWORD}' - a known password, correct for this throwaway directory and wrong `
    + 'for any other.')
} finally {
  instance.close()
}
