'use strict'
// Worker-thread entry for the Perfetto summarizer (PRF-06). The summarizer is synchronous and can spend
// 11-17 s of CPU on a crafted trace at default limits (ADR 0010 notes), so it never runs on Studio's event loop.
const { parentPort, workerData } = require('node:worker_threads')
const { summarizeFile } = require('./perfetto-summary')

parentPort.postMessage(summarizeFile(workerData.file, workerData.opts))
