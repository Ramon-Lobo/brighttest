import { defineConfig } from 'vitest/config'

// Unit tests for brighttest's own logic (config, coverage parsing, reporter, CLI args).
// The lib/ modules are CommonJS; Vitest imports them via interop. Fast, no compile/simulator.
// Integration tests live under test/integration/ and run via vitest.integration.config.mjs.
export default defineConfig({
  test: {
    include: ['test/*.test.js'],
    environment: 'node',
    // Many files compile with bsc or spawn the CLI; the 5s default flakes when the suite runs files in parallel on a loaded machine.
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./test/support/no-foreground-check.js', './test/support/win32-long-tmpdir.js'],
  },
})
