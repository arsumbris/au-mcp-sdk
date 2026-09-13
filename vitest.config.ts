import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The SDK is contract types + a thin client; it has no tests of its own yet.
    // Keep `pnpm -r test` green rather than failing the aggregate on an empty package.
    passWithNoTests: true,
  },
})
