import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['packages/**/test/**/*.test.ts?(x)', 'apps/**/test/**/*.test.ts?(x)'] },
})
