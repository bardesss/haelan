import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// demo/capture/ has no package.json of its own (server.ts's own comment already explains why: a
// deep relative import is the only thing a bare specifier could resolve against here), so a bare
// `import 'react'` in record.tsx would otherwise walk up from demo/capture/ to the repository
// root's node_modules and fail there - react, react-dom and @tanstack/react-query are apps/web's
// dependencies, installed under apps/web/node_modules, not hoisted to the root. Every OTHER import
// record.tsx makes resolves fine without help: apps/web/src/*.ts(x) files sit inside apps/web
// itself, so their own bare imports resolve from there regardless of who imported them - it is
// only the handful of third party packages record.tsx names directly that need pointing at where
// they actually live.
const WEB_NODE_MODULES = fileURLToPath(new URL('../../apps/web/node_modules', import.meta.url))

// The recorder's own config, deliberately not extending the root one: this file's `include` is
// the sweep vitest itself mounts pages through (record.tsx, Task 3), and it must never match the
// root config's globs (packages|apps|scripts)/**/test/**, or `pnpm test` would run a real Fastify
// instance against a freshly seeded, rebuilt directory as part of the ordinary suite.
export default defineConfig({
  resolve: {
    alias: [
      // jsx-dev-runtime is not something record.tsx names itself - it is what esbuild's JSX
      // transform injects for every file with JSX in it, this one included, so it needs the same
      // pointer as the bare imports actually written below.
      { find: /^react\/jsx-dev-runtime$/, replacement: join(WEB_NODE_MODULES, 'react/jsx-dev-runtime') },
      { find: /^react\/jsx-runtime$/, replacement: join(WEB_NODE_MODULES, 'react/jsx-runtime') },
      { find: /^react$/, replacement: join(WEB_NODE_MODULES, 'react') },
      { find: /^react-dom\/client$/, replacement: join(WEB_NODE_MODULES, 'react-dom/client') },
      { find: /^@tanstack\/react-query$/, replacement: join(WEB_NODE_MODULES, '@tanstack/react-query') },
    ],
  },
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
