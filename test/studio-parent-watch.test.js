import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { watchParent } = require('../lib/studio/parent-watch.js')

function fakeTimers() {
  const t = { fn: null, cleared: 0, tick() { if (t.fn) t.fn() } }
  t.setIntervalFn = (fn) => { t.fn = fn; return { unref() {} } }
  t.clearIntervalFn = () => { t.cleared++; t.fn = null }
  return t
}

describe('watchParent', () => {
  it('is a no-op without npm_command=exec', () => {
    const t = fakeTimers()
    watchParent({ ppid0: 100, env: {}, getPpid: () => 1, onGone() { throw new Error('no') }, ...t })
    expect(t.fn).toBe(null)
    watchParent({ ppid0: 100, env: { npm_command: 'run-script' }, getPpid: () => 1, onGone() {}, ...t })
    expect(t.fn).toBe(null)
  })
  it('is a no-op when the parent is already init', () => {
    const t = fakeTimers()
    watchParent({ ppid0: 1, env: { npm_command: 'exec' }, onGone() {}, ...t })
    expect(t.fn).toBe(null)
  })
  it('never fires while the ppid is stable', () => {
    const t = fakeTimers(); let n = 0
    watchParent({ ppid0: 100, env: { npm_command: 'exec' }, getPpid: () => 100, onGone: () => n++, ...t })
    t.tick(); t.tick()
    expect(n).toBe(0)
  })
  it('fires once on a ppid change', () => {
    const t = fakeTimers(); let n = 0; let pp = 100
    watchParent({ ppid0: 100, env: { npm_command: 'exec' }, getPpid: () => pp, onGone: () => n++, ...t })
    pp = 1
    const fn = t.fn
    fn(); fn()
    expect(n).toBe(1)
  })
  it('stop() clears the timer', () => {
    const t = fakeTimers()
    const stop = watchParent({ ppid0: 100, env: { npm_command: 'exec' }, getPpid: () => 100, onGone() {}, ...t })
    stop()
    expect(t.cleared).toBe(1)
  })
})
