import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The directory holding pnpm-workspace.yaml, found by walking up from `from`.
 *
 * Not `new URL('../package.json', import.meta.url)`, which is the obvious way to write this and
 * throws for one of the three callers. `apps/web/test/flush.test.tsx` imports the root
 * vitest.config.ts as a module to assert a value out of it, so this file is evaluated inside the
 * test runtime as well as by node - and there `import.meta.url` is not a `file:` URL, so
 * fileURLToPath refuses it with "The URL must be of scheme file". The suite caught it; nothing
 * else would have, since both configs load fine on their own.
 *
 * Walking up works for all three: vitest runs from the repo root, the web build runs from
 * apps/web, and the test importing the config runs from the root again.
 */
function workspaceRoot(from: string): string {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error(`no pnpm-workspace.yaml above ${from}; cannot find the version`)
    dir = up
  }
}

/**
 * The version this repository is at, read from the one package.json that carries it.
 *
 * The root package.json is the release version - release-please bumps it, and the tag, the image
 * and the landing page all follow from it. `apps/server/package.json` is still 0.1.0 and has never
 * been the release version, so reading that one would show a number nothing else agrees with.
 *
 * Two callers, which is the whole reason this is a module. `apps/web/vite.config.ts` builds the
 * app and the root `vitest.config.ts` runs the suite, and they do not share a config - so a
 * literal written into each is precisely the cross-file drift this repo keeps guards against, with
 * the added twist that the tests would be the copy that stayed right while the shipped bundle went
 * stale.
 */
export function appVersion(): string {
  const path = join(workspaceRoot(process.cwd()), 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`no version in ${path}; the About card would render "undefined"`)
  }
  return pkg.version
}
