import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts?(x)', 'apps/**/test/**/*.test.ts?(x)'],
    // Well above vitest's 5s default, because a lot of this suite is not unit work: a sync run
    // walks eighteen data types, gzips a payload per window and commits each one through
    // SQLite, and argon2 is deliberately expensive. Under the parallelism of a full run those
    // are seconds each. The budget is here so a genuinely hung test still fails rather than
    // hanging forever, and so it is one number rather than a per file sprinkle.
    testTimeout: 20_000,
  },
})
