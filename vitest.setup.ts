// Runs before every test file; see setupFiles in vitest.config.ts for why this exists.

declare global {
  // TypeScript only puts a declared global on globalThis when it is declared with `var`.
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export {}
