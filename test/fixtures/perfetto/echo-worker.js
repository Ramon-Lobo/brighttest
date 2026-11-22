'use strict'
// Test-only worker that echoes the options it was given (asserts the route's call-site limits).
const { parentPort, workerData } = require('node:worker_threads')
parentPort.postMessage({ ok: true, summary: { opts: workerData.opts } })
