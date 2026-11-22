import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// A child with NO signal handler of its own: only the lease module may clean up. The store's createExclusive is
// wrapped so that right after holder.json is created the child announces it and blocks synchronously (the window
// between createExclusive and registerHeld), so the parent's SIGINT is guaranteed to land inside it.
let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sig-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const holders = (d) => { try { return fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith('holder.json')) } catch { return [] } }

describe('signal between createExclusive and registerHeld', () => {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    // Windows has no catchable SIGINT/SIGTERM: child.kill() is TerminateProcess, no handler or exit hook runs
    it.skipIf(process.platform === 'win32')(`${sig} in that window leaves no holder.json and the child dies by the signal`, async () => {
      const lz = path.join(dir, 'lz')
      const ready = path.join(dir, 'ready')
      const script = path.join(dir, 'child.cjs')
      fs.writeFileSync(script, `
        const fs = require('node:fs');
        const lease = require(${JSON.stringify(path.resolve('lib/device-lease.js'))});
        const store = lease.createStore({ dir: ${JSON.stringify(lz)}, env: {} });
        const real = store.createExclusive;
        store.createExclusive = (...a) => {
          const r = real(...a);
          if (r) { fs.writeFileSync(${JSON.stringify(ready)}, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); }
          return r;
        };
        lease.acquire({ store, host: '127.0.0.1', port: 8060, env: {}, waitMs: 0, timers: false, foregroundCheck: false, onWarn: () => {} })
          .then(() => setInterval(() => {}, 1000));
      `)
      const child = spawn(process.execPath, [script], { stdio: 'ignore' })
      const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
      const end = Date.now() + 5000
      while (!fs.existsSync(ready) && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
      expect(fs.existsSync(ready)).toBe(true)
      expect(holders(lz)).toHaveLength(1) // created, not yet registered
      child.kill(sig)
      const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))])
      if (res === 'timeout') child.kill('SIGKILL')
      expect(res).toEqual({ code: null, signal: sig })
      expect(holders(lz)).toEqual([])
    })
  }
})
