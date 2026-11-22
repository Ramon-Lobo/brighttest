'use strict'
// Child process for test/mcp-net-window.test.js: a real `run()` MCP server on stdio with a stub device and a stub hub.
// SIGUSR2 makes it throw an uncaught error (the onFatal path).
const { run } = require('../../lib/mcp/server.js')
const devices = {
  resolveDevice: () => ({ host: '127.0.0.1', password: null, source: 'env' }),
  resolveEcpPort: () => 8060,
  cachedDevices: () => [],
}
process.on('SIGUSR2', () => setTimeout(() => { throw new Error('boom') }, 0))
run({ cwd: process.cwd(), deps: { devices, startLanHub: async () => ({ stop: async () => {} }) } })
