'use strict'
// Runs summarizeFile in a worker thread with a hard timeout and a heap cap (PRF-06, ADR 0010).
// Always resolves to the summarizer's result shape: { ok: true, summary } | { ok: false, error: { code, message, offset } }.
// Extra codes from isolation: E_TRACE_TIMEOUT (worker terminated), E_TRACE_WORKER (crash or heap exhaustion),
// E_TRACE_BUSY (concurrency cap reached, no worker started), E_TRACE_ABORTED (caller's signal fired).
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const MIB = 1024 * 1024
const DEFAULTS = { maxInflatedBytes: 32 * MIB, timeoutMs: 15000, maxHeapMb: 512 }

const MAX_CONCURRENT = 2

// A pool tracks in-flight workers so callers can cap concurrency and terminate everything on shutdown.
function createPool(max = MAX_CONCURRENT) {
  const inflight = new Set()
  return { max, inflight, terminateAll() { for (const cancel of [...inflight]) cancel() } }
}
const defaultPool = createPool()

function summarizeIsolated(file, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const pool = o.pool || defaultPool
  const fail = (code, message) => ({ ok: false, error: { code, message, offset: null } })
  return new Promise((resolve) => {
    if (o.signal && o.signal.aborted) return resolve(fail('E_TRACE_ABORTED', 'request aborted'))
    if (pool.inflight.size >= pool.max) return resolve(fail('E_TRACE_BUSY', 'too many summaries in progress, retry shortly'))
    let done = false
    let worker
    let timer
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      pool.inflight.delete(cancel)
      if (o.signal) o.signal.removeEventListener('abort', cancel)
      if (worker) worker.terminate().catch(() => {})
      resolve(r)
    }
    const cancel = () => finish(fail('E_TRACE_ABORTED', 'summary cancelled'))
    pool.inflight.add(cancel)
    if (o.signal) o.signal.addEventListener('abort', cancel, { once: true })
    try {
      worker = new Worker(o.workerPath || path.join(__dirname, 'perfetto-summary-worker.js'), {
        workerData: { file, opts: { limits: { maxInflatedBytes: o.maxInflatedBytes } } },
        resourceLimits: { maxOldGenerationSizeMb: o.maxHeapMb },
      })
    } catch (e) { return finish(fail('E_TRACE_WORKER', 'cannot start summarizer worker')) }
    timer = setTimeout(() => finish(fail('E_TRACE_TIMEOUT', `summary exceeded ${o.timeoutMs} ms`)), o.timeoutMs)
    worker.on('message', (m) => finish(m && typeof m === 'object' && 'ok' in m ? m : fail('E_TRACE_WORKER', 'bad worker reply')))
    worker.on('error', (e) => finish(fail('E_TRACE_WORKER', e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'summarizer ran out of memory' : 'summarizer crashed')))
    worker.on('exit', () => finish(fail('E_TRACE_WORKER', 'summarizer exited without a result')))
  })
}

module.exports = { summarizeIsolated, createPool, DEFAULTS, MAX_CONCURRENT }
