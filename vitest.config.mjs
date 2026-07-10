import { defineConfig } from 'vitest/config'

// Unit tests for brighttest's own logic (config, coverage parsing, reporter, CLI args).
// The lib/ modules are CommonJS; Vitest imports them via interop. Fast, no compile/simulator.
// Integration tests live under test/integration/ and run via vitest.integration.config.mjs.
export default defineConfig({
  test: {
    include: ['test/*.test.js'],
    environment: 'node',
  },
})
