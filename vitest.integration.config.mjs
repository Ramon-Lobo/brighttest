import { defineConfig } from 'vitest/config'

// Integration tests: each spawns the real CLI, which compiles a fixture project with bsc and runs it
// on the brs-node simulator. They're much slower than the unit suite (seconds each), so they get long
// timeouts and run one file at a time — concurrent brs-node processes would contend for CPU/memory
// (the coverage lane requests a large V8 heap).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.js'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
})
