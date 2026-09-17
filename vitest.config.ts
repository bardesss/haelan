import { cpus } from 'node:os'
import { defineConfig } from 'vitest/config'
import { appVersion } from './scripts/app-version.ts'

/**
 * Six was measured on a 22-core development machine, where it is both faster and more reliable
 * than the one-fork-per-core default. Six on a CI runner with four cores is the opposite: it is
 * oversubscription, which is the very thing the cap exists to prevent, and it duly timed out a
 * 61ms test at 64s on one leg of the matrix while the other leg passed.
 *
 * So the cap is now the smaller of that measurement and what the machine can actually carry.
 * Leaving one core free matters more than the exact fraction: the runner still has a main process,
 * and a suite that saturates every core makes its own timing budgets meaningless.
 */
const WORKERS = Math.max(1, Math.min(6, cpus().length - 1))

export default defineConfig({
  // The same constant apps/web/vite.config.ts bakes into the bundle, from the same helper. The
  // suite does not load that config, so without this the About card renders "undefined" in every
  // test while being correct in the app - the direction of drift that stays hidden longest.
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  test: {
    include: ['packages/**/test/**/*.test.ts?(x)', 'apps/**/test/**/*.test.ts?(x)', 'scripts/test/**/*.test.ts'],
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
    // See WORKERS above: the measurement is a ceiling, not the number itself, because the slowest
    // machine that has to run this suite is a CI runner and not the one it was measured on.
    maxWorkers: WORKERS,
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
    // happy-dom answers '(prefers-reduced-motion: reduce)' from this setting, and its default is
    // 'no-preference'. useChart reads exactly that query and feeds it to withMotionPreference, so
    // the default left echarts animation ON in every test that mounts a chart - which is every page
    // test file under apps/web/test.
    //
    // That is what made flush() wait on the wrong thing. flush() returns on two consecutive samples
    // of the same innerHTML, and an animating echarts SVG rewrites its paths every frame, so the
    // helper was not waiting for data at all: it was waiting out an animation clock. Instrumented
    // with counters, every flush in activity.test.tsx saw the in-flight count at zero on every pump
    // (all queries had landed inside the first one) and saw the HTML change on every pump but the
    // last, 26 to 129 pumps deep. The reason to set the preference is that waiting is pure waste:
    // no assertion anywhere reads a frame of it.
    //
    // Measured as an A/B, five concurrent full apps/web runs each way, 940 flushes per round:
    //
    //           mean    median   p95     p99     max      total in flush
    //   on      1252ms  1291ms   3072ms  3830ms  5901ms   1177s
    //   off      564ms   279ms   1841ms  2649ms  4435ms    531s
    //
    // So this halves the time the whole suite spends in flush() and takes 928 of 940 calls down to
    // the two-pump minimum. Be honest about the tail, though: it improves only 5.9s to 4.4s against
    // the 10s budget, because under that much contention a single pump costs seconds and flush needs
    // two of them no matter what. This removes the largest avoidable term, not the fragility itself -
    // what is left is the per-pump cost, which is the machine's, and the real trigger behind the
    // "flush() timed out" flakes seen here is several of these suites running at once out of
    // separate worktrees, which maxWorkers above cannot see or cap.
    //
    // Nothing is lost by it: no test asserts that a mounted chart animates, and motion.test.ts covers
    // the decision itself by calling withMotionPreference directly, with no DOM and no matchMedia. It
    // also removes a quieter hazard - with animation on, anything reading chart geometry could sample
    // a half drawn frame.
    //
    // Declared here rather than assigned in vitest.setup.ts so it is part of how the environment is
    // built, not a mutation applied after it already exists; happy-dom deep merges `device` over its
    // own defaults (BrowserSettingsFactory), so naming one key leaves the rest alone.
    environmentOptions: {
      happyDOM: { settings: { device: { prefersReducedMotion: 'reduce' } } },
    },
  },
})
