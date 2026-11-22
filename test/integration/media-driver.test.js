import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeProject, runCli, cleanupTemp } from './helpers.js'

// COV-16: the BTMedia_* headless media-state driver on the real engine: a plain suite and an @SGNode suite.
afterAll(cleanupTemp)

describe('BTMedia_ driver on the scene lanes', () => {
  it('passes the plain and @SGNode suites on the default lane', () => {
    const res = runCli(makeProject('media-driver'))
    expect(res.status).toBe(0)
    expect(res.output).toContain('10 passed, 0 failed')
    expect(res.output).toContain('✓ shows the spinner while buffering and hides it on playing')
    expect(res.output).toContain('✓ walks load, play, tick and finish')
  }, 120000)

  it('passes the same suites with --coverage', () => {
    const res = runCli(makeProject('media-driver'), ['--coverage'])
    expect(res.status).toBe(0)
    expect(res.output).toContain('10 passed, 0 failed')
  }, 120000)

  it('a deliberate wrong expectation fails with the expected message', () => {
    const dir = makeProject('media-driver')
    const f = path.join(dir, 'source', 'tests', 'Media.spec.bs')
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('m.assertEqual(r.state, "playing")', 'm.assertEqual(r.state, "paused")'))
    const res = runCli(dir)
    expect(res.status).not.toBe(0)
    expect(res.output).toContain('answers the app')
    expect(res.output).toContain('expected "\"playing\"" to equal "\"paused\""')
  }, 120000)

  it('--no-sgnode prints that the lane has no roSGNode', () => {
    const res = runCli(makeProject('media-driver'), ['--no-sgnode'])
    expect(res.output).toContain('no roSGNode')
  }, 120000)
})
