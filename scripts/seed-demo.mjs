// Seeds a fresh data directory with a year of plausible demo data, so an instance can be booted
// against it and looked at - either by a household kicking the tyres or by the next unit taking
// README screenshots. A rebuild follows the seed in the same run, because a directory holding
// only `raw_payloads` boots to an empty dashboard until something derives from it, and there is
// no reason to make whoever runs this wait for the next boot to find that out.
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
const { seedArchive } = await import('../packages/core/src/testing/seed.ts')
const { runRebuild } = await import('../packages/core/src/rebuild/runRebuild.ts')
const { PeopleStore } = await import('../packages/core/src/store/people.ts')

const PERSON_ID = 'demo'

// Anchored, not "today". Spec section 3 requires a screenshot regenerated next month to show the
// same chart, and the fixed PRNG below only guarantees that if the calendar window it draws over
// is fixed too - weekday alignment (isSunday in seed.ts) moves against a fixed draw sequence
// whenever the end date moves, so "always looks current" and "reproducible" cannot both hold.
// This is the ruling: reproducible wins, since it is what the spec actually asked for. Midnight
// UTC, exclusive, the same convention seedArchive's own endMs carries.
const DEMO_END_DATE = '2026-09-07'
const endMs = Date.parse(`${DEMO_END_DATE}T00:00:00Z`)

const instance = openHaelan(dir)
try {
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
    nowMs: Date.now(),
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
} finally {
  instance.close()
}
