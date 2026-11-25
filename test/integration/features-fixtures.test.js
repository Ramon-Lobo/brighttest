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
afterAll(() => { cleanupTemp(); for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }) })

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

describe('feature-tree-app run evidence from the headless JUnit', () => {
  it('shows ran-headless through features render, mapped by the file attribute (no specSuites needed)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fte-'))
    tmp.push(d)
    fs.cpSync(APP, d, { recursive: true, filter: (s) => !/[\\/](\.brighttest|coverage)$/.test(s) })
    expect(runCli(d, ['--junit', 'reports/junit.xml']).status).toBe(0)
    const xml = fs.readFileSync(path.join(d, 'reports', 'junit.xml'), 'utf8')
    expect(xml).toContain('<property name="brighttest.lane" value="headless"/>')
    expect(xml).toContain('file="source/tests/StringUtils.spec.bs"')
    expect(runCli(d, ['features', 'graph']).status).toBe(0)

    const withSuites = runCli(d, ['features', 'render', '--auto', '--junit', 'reports/junit.xml'])
    expect(withSuites.status).toBe(0)
    const html = fs.readFileSync(path.join(d, '.brighttest', 'features', 'report.html'), 'utf8')
    expect(html).toContain('ran-headless (2 cases passed)')
    expect(html).not.toContain('ran-device (')
    expect(withSuites.stderr).not.toContain('warning')
    expect(withSuites.stderr).not.toContain('hint')

    // A graph without specSuites (older graph): the file attribute still maps every case, and no hint is printed.
    const gp = path.join(d, '.brighttest', 'features', 'graph.json')
    const g = JSON.parse(fs.readFileSync(gp, 'utf8'))
    delete g.specSuites
    fs.writeFileSync(gp, JSON.stringify(g, null, 2))
    const bare = runCli(d, ['features', 'render', '--auto', '--junit', 'reports/junit.xml'])
    expect(bare.stderr).not.toContain('warning')
    expect(bare.stderr).not.toContain('hint')
    expect(fs.readFileSync(path.join(d, '.brighttest', 'features', 'report.html'), 'utf8')).toContain('ran-headless (2 cases passed)')

    // An older JUnit (no file attribute) against that graph: one hint to re-run features graph, never an error.
    const old = xml.replace(/ file="[^"]*"/g, '').replace(/\s*<properties>[\s\S]*?<\/properties>/, '')
    fs.writeFileSync(path.join(d, 'reports', 'old.xml'), old)
    const legacy = runCli(d, ['features', 'render', '--auto', '--junit', 'reports/old.xml'])
    expect(legacy.status).toBe(0)
    expect(legacy.stderr.match(/hint: /g)).toHaveLength(1)
    expect(legacy.stderr).toContain('features graph')
  }, 120000)
})
