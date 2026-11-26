import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, cleanupTemp } from './helpers.js'

// The feature-tree-app fixture runs headless through the real CLI (no device). It is copied to a
// temp dir so no staging output lands in the repo. Slow, so it is here and not in test/features-fixtures.test.js.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'feature-tree-app')
const tmp = []
// Remove only this suite's own dirs. A straggler process can still be writing into the tree for a moment, which
// makes a plain rmSync fail with ENOTEMPTY, so retry; a cleanup failure is logged and never fails the suite.
afterAll(() => {
  try { cleanupTemp() } catch (e) { console.warn(`bt-ftx cleanupTemp failed: ${e.message}`) }
  for (const d of tmp) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    catch (e) { console.warn(`bt-ftx cleanup failed for ${d}: ${e.message}`) }
  }
})

describe('feature-tree-app', () => {
  it('passes headless: one pure suite and one @SGNode suite', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ftx-'))
    tmp.push(d)
    fs.cpSync(APP, d, { recursive: true, filter: (s) => !/[\\/](\.brighttest|coverage)$/.test(s) })
    const res = runCli(d)
    expect(res.status).toBe(0)
    expect(res.output).toContain('3 passed, 0 failed')
    expect(res.output).toContain('2 suites')
  }, 120000)
})
