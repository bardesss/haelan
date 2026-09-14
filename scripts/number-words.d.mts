// A declaration shim for number-words.mjs, read by the tests in scripts/test that import it.
// TypeScript resolves a `.mjs` import against a same-named `.d.mts` beside it without needing
// `allowJs` anywhere in the program. Keep it in sync with what number-words.mjs exports.
export function numberWord(n: number): string
export function joinWords(parts: readonly string[]): string
