// A declaration shim for build-site.mjs, read only by scripts/test/build-site.test.ts and
// scripts/test/site-assets.test.ts. TypeScript resolves a `.mjs` import against a same-named
// `.d.mts` beside it without needing `allowJs` anywhere in the program. Keep it in sync with
// what build-site.mjs exports.
export function renderPage(template: string, values: Record<string, string>): string
export function releaseStamp(rootDir: string): { version: string, releaseDate: string }
