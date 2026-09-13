import { defineConfig } from 'vitest/config'

// The recorder's own config, deliberately not extending the root one: this file's `include` is
// the sweep vitest itself mounts pages through (record.tsx, Task 3), and it must never match the
// root config's globs (packages|apps|scripts)/**/test/**, or `pnpm test` would run a real Fastify
// instance against a freshly seeded, rebuilt directory as part of the ordinary suite.
export default defineConfig({
  test: {
    include: ['demo/capture/record.tsx'],
    environment: 'happy-dom',
    // Same as the root config: happy-dom answers '(prefers-reduced-motion: reduce)' from this
    // setting, and the demo mounts the same chart-bearing pages that setting exists for - see
    // vitest.config.ts's own comment for the measurement behind it.
    environmentOptions: {
      happyDOM: { settings: { device: { prefersReducedMotion: 'reduce' } } },
    },
  },
})
