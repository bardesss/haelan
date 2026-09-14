// A declaration shim for sync-readme-screenshots.mjs, read only by
// scripts/test/screenshots.test.ts. TypeScript resolves a `.mjs` import against a same-named
// `.d.mts` beside it without needing `allowJs` anywhere in the program. Keep it in sync with what
// sync-readme-screenshots.mjs exports.
export function readmeScreenshots(): string
export function render(readme: string): string
