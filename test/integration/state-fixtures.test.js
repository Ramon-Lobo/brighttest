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
    expect(res.output).toContain('5 passed, 0 failed')
    expect(res.status).toBe(0)
  }, 120000)

  it('passes with --coverage', () => {
    const res = runCli(makeProject('state-fixtures'), ['--coverage'])
    expect(res.output).toContain('5 passed, 0 failed')
    expect(res.status).toBe(0)
  }, 120000)

  // Known runner bug (out of scope here, logged as a finding): a throw from BTState_load in an @SGNode beforeEach makes
  // Rooibos print CRASH then "Total 0 / Success", and brighttest exits 0. When fixed, this passes and `.fails` must go.
  it.fails('missing fixture -> non-zero exit (Rooibos beforeEach crash reports success)', () => {
    const dir = makeProject('state-fixtures')
    const f = path.join(dir, 'source', 'tests', 'Snapshot.spec.bs')
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('premium.json', 'nope.json'))
    const res = runCli(dir)
    expect(res.status).not.toBe(0)
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
