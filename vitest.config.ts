import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts?(x)', 'apps/**/test/**/*.test.ts?(x)'],
    // Well above vitest's 5s default, because a lot of this suite is not unit work: a sync run
    // walks eighteen data types, gzips a payload per window and commits each one through
    // SQLite, and argon2 is deliberately expensive. Under the parallelism of a full run those
    // are seconds each. The budget is here so a genuinely hung test still fails rather than
    // hanging forever, and so it is one number rather than a per file sprinkle.
    //
    // Raised again for the backfill sprint (Task 6): oauth consent now starts the first sync
    // itself, and that first sync loops batches until every type has 90 days of history before
    // it does anything else. Any test that completes consent pays for that sprint in its
    // afterEach cleanup even if the test body never touches syncing, because cleanup awaits
    // runner.settle() rather than closing the database out from under an in-flight run.
    testTimeout: 45_000,
    // Vitest's hook timeout does not inherit testTimeout - it defaults to 10s regardless. The
    // settle() above runs in afterEach, so without raising this too, cleanup would time out
    // well before the test body's own budget was in danger.
    hookTimeout: 45_000,
  },
})
