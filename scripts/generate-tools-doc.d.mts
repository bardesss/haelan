// A declaration shim for generate-tools-doc.mjs, read only by apps/server/test/tools-doc-drift.test.ts.
// TypeScript resolves a `.mjs` import against a same-named `.d.mts` beside it without needing
// `allowJs` anywhere in the program: the `.mjs` body itself never enters the type-checked program,
// only this signature does. Keep it in sync with the one function generate-tools-doc.mjs exports.
export function render(): string
