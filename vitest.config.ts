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
    // Capped, because uncapped was both slower and unreliable.
    //
    // vitest defaults to roughly one fork per core, which is 22 on this machine. A lot of this
    // suite is server tests that each create a temp directory, open SQLite, run every migration,
    // then gzip and commit a payload per window across every listable data type. Twenty-two of
    // those at once contend for one disk, and the contention is superlinear: measured, an
    // ordinary 1.7s test ("delivers progress events to a subscriber and stops after unsubscribe")
    // exceeded the 20s budget above during a full run - a 12x stretch, where the comment on that
    // budget assumed 2x was the danger line.
    //
    // Measured on the full suite: uncapped 260s with a test failing, capped at 6 workers 241s with
    // none of that class failing. Fewer workers is FASTER here, which is the tell that the
    // bottleneck is contention rather than CPU. Raising testTimeout instead would have bought the
    // same green run by blinding the hang-detector for all 2500 tests.
    //
    // Six is measured, not chosen for elegance. If this moves, re-measure - and re-measure on the
    // slowest machine that has to run it, not the fastest.
    maxWorkers: 6,
    // Sets globalThis.IS_REACT_ACT_ENVIRONMENT, which is React's switch for "this is a test".
    // Nothing set it before, and both halves of that were costing us something.
    //
    // The loud half: with the flag unset, every React update made inside act() trips
    // isConcurrentActEnvironment() and logs "The current testing environment is not configured to
    // support act(...)", three times over a plain render/setState/unmount cycle. Green runs hide
    // it, because vitest only prints a file's stderr when that file fails, so the noise surfaced
    // only next to a real failure and read as a symptom of it. It sent a flush.ts investigation
    // down a blind alley once already.
    //
    // The quiet half, and the reason this is a setup file rather than a line in one test:
    // warnIfUpdatesNotWrappedWithActDEV checks the same flag, so with it unset React never emits
    // "An update to X inside a test was not wrapped in act(...)" at all. That is the warning that
    // catches a state update escaping act(), a real race between a test's assertions and a render
    // it did not wait for, and the ~15 happy-dom files under apps/web/test that mount components
    // were all running without it.
    //
    // Global rather than per file because the flag is inert where React is not: the node-environment
    // tests never load react-dom, so setting it there costs one assignment and nothing else, while a
    // per file opt-in is one more thing a new component test can forget, which is exactly how the
    // suite ended up here.
    setupFiles: ['./vitest.setup.ts'],
  },
})
