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
    // It is the budget for an *ordinary* test. A handful of tests assert against production's
    // own sprint numbers and legitimately cost ten seconds or more; they declare their own
    // budget at the test (see SPRINT_BUDGET_MS in apps/server/test/sync-runner.test.ts). Raising
    // this number to fit them would mean the other six hundred no longer have anything worth
    // calling a hang-detector. Note also that nothing here caps parallelism, so vitest runs
    // roughly one fork per core: how much CPU any one test gets depends on what else is running,
    // which is why a test with less than a 2x margin here eventually flakes.
    testTimeout: 20_000,
  },
})
