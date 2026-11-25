'use strict'
// `vitepress build docs` writes docs/.vitepress/.temp and the config bundle next to the sources, so two builds of the
// same docs dir running at once (docs-agent-files and docs-seo run in parallel workers) corrupt each other and one
// exits 1 with ERR_MODULE_NOT_FOUND. Serialise the builds across worker processes with an atomic lock directory.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const LOCK = path.join(os.tmpdir(), 'brighttest-docs-build.lock')
const STALE_MS = 10 * 60 * 1000
const WAIT_MS = 8 * 60 * 1000

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function acquire() {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    try { fs.mkdirSync(LOCK); return } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true }) } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for the docs build lock')
      sleep(250)
    }
  }
}

// spawnSync under the lock (same arguments and return value as child_process.spawnSync).
function spawnDocsBuild(cmd, args, opts) {
  acquire()
  try { return spawnSync(cmd, args, opts) } finally { fs.rmSync(LOCK, { recursive: true, force: true }) }
}

module.exports = { spawnDocsBuild }
