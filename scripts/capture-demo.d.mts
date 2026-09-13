// A declaration shim for capture-demo.mjs, read only by scripts/test/capture-demo.test.ts.
// TypeScript resolves a `.mjs` import against a same-named `.d.mts` beside it without needing
// `allowJs` anywhere in the program (build-site.d.mts is the same pattern, for the same reason).
// Keep it in sync with what capture-demo.mjs exports.
export function writeCapture(outDir: string, recorded: Map<string, unknown>): { files: number, bytes: number }
