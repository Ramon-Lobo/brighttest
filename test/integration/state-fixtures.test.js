import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeProject, runCli, cleanupTemp } from './helpers.js'

// STA-S-T12 (TP-STA-24, headless half): BTState_load + BTState_seedGlobals in an @SGNode beforeEach, with
// fixtures/state/** shipped through {src,dest}.
afterAll(cleanupTemp)

describe('BTState_ snapshot fixtures on the scene lanes', () => {
  it('seeds m.global from fixtures/state/premium.json on the default lane (rooibos on brs-node)', () => {
    const res = runCli(makeProject('state-fixtures'))
    expect(res.output).toContain('4 passed, 0 failed')
    expect(res.status).toBe(0)
  }, 120000)

  it('passes with --coverage', () => {
    const res = runCli(makeProject('state-fixtures'), ['--coverage'])
    expect(res.output).toContain('4 passed, 0 failed')
    expect(res.status).toBe(0)
  }, 120000)

  it('a wrong expectation fails with the expected message', () => {
    const dir = makeProject('state-fixtures')
    const f = path.join(dir, 'source', 'tests', 'Snapshot.spec.bs')
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"Tier: premium"', '"Tier: free"'))
    const res = runCli(dir)
    expect(res.status).not.toBe(0)
    expect(res.output).toContain('lets the app read the seeded values')
  }, 120000)
})
