import { defineConfig } from 'vitest/config'

// Unit tests for brighttest's own logic (config, coverage parsing, reporter, CLI args).
// The lib/ modules are CommonJS; Vitest imports them via interop. Tests live in test/.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
