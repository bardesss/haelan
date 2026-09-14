import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { emitCss } from '../../packages/tokens/src/emit.js'

/**
 * Writes `packages/tokens/dist/theme.css` if it is not already there, so a test that calls
 * `buildSite` can run on a machine that has never built.
 *
 * That file is a build artifact and `ci.yml` runs `pnpm test` **ahead of** `pnpm build`, so on CI
 * and on a fresh clone it does not exist — while on a developer's machine it does, left behind by
 * an earlier build. A test that copies it therefore passes locally and fails on CI, which is
 * exactly what happened to `demo-build.test.ts` the first time it called `buildSite`.
 *
 * Shared rather than copied: `site-assets.test.ts` had this function first and
 * `demo-build.test.ts` needed the identical thing, which is the point at which a second copy
 * starts drifting. Not a `.test.ts` file, so vitest's include globs do not try to run it.
 *
 * It writes from `emitCss`, the same emitter the package's own `build:css` script uses, so the
 * test exercises the real copy path rather than a stub.
 */
export function ensurePalette(): void {
  const css = new URL('../../packages/tokens/dist/theme.css', import.meta.url)
  if (existsSync(css)) return
  mkdirSync(new URL('../../packages/tokens/dist/', import.meta.url), { recursive: true })
  writeFileSync(css, emitCss())
}
