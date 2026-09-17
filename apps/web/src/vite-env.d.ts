/// <reference types="vite/client" />

/**
 * The version this bundle was built from, replaced at build time by a `define` in
 * apps/web/vite.config.ts and, for the suite, in the root vitest.config.ts. Both read it from
 * scripts/app-version.ts, which reads the root package.json.
 *
 * Declared rather than imported because it is a literal substituted into the source, not a module:
 * nothing exports it, and by the time the browser sees it, it is a string.
 */
declare const __APP_VERSION__: string
