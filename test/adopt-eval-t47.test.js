import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const t47 = require('../scripts/adopt-eval/t47')
const FX = path.join(__dirname, 'fixtures', 'adopt-eval', 't47')
const CLI = path.join(__dirname, '..', 'scripts', 'adopt-eval', 't47.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-t47-'))
const read = (f) => fs.readFileSync(f, 'utf8')
function cellWith(root, id, fixture, meta) {
  const dir = path.join(root, ...id.split('/')), app = path.join(dir, 'app')
  fs.cpSync(path.join(FX, fixture), app, { recursive: true })
  if (meta) fs.writeFileSync(path.join(dir, '.t47-meta.json'), JSON.stringify({ input: 't4-end-state' }))
  return app
}
const T4_CELL = {
  finalMessage: 'BTStore keeps state in memory only; it has a depth limit and does not persist across launches. There is no time-travel.',
  commands: ['npx brighttest init --greenfield', 'npx brighttest', 'npx brighttest e2e lint flows/list-to-detail.e2e.yaml'],
  exitCodes: { 'npx brighttest init --greenfield': 0, 'npx brighttest': 0, 'npx brighttest e2e lint flows/list-to-detail.e2e.yaml': 0 },
}

describe('prepare', () => {
  test('T4 cell: skeleton copy, one commit, TP-ADOPT-14 prompt', () => {
    const root = path.join(tmp(), 'run')
    const r = t47.prepare({ runRoot: root })
    expect(r.app).toBe(path.join(root, 'greenfield', 't4', 'app'))
    expect(fs.existsSync(path.join(r.app, 'components', 'HomeScene.xml'))).toBe(true)
    expect(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: r.app, encoding: 'utf8' }).stdout.trim()).toBe('1')
    expect(read(path.join(r.dir, 'prompt.md'))).toMatch(/^Turn this skeleton into a testable Roku app with one feature \(a list screen with a detail view\) and tests\./)
    expect(() => t47.prepare({ runRoot: root })).toThrow(/not empty/)
    expect(() => t47.prepare({ runRoot: root, clean: true })).not.toThrow()
    expect(() => t47.prepare({ runRoot: path.join(__dirname, 'x') })).toThrow(/outside the repo/)
  })
  test('T5 cell: copies the T4 end state, original untouched; refuses legacy input', () => {
    const base = tmp(), from = path.join(base, 'end')
    fs.cpSync(path.join(FX, 't4-good'), from, { recursive: true })
    const root = path.join(base, 'run')
    const r = t47.prepareT5({ runRoot: root, from })
    expect(fs.existsSync(path.join(r.app, 'flows', 'list-to-detail.e2e.yaml'))).toBe(true)
    expect(read(path.join(r.dir, 'prompt.md'))).toMatch(/^Add CI for brighttest to this project \(GitHub Actions\)\./)
    fs.writeFileSync(path.join(r.app, 'x'), '1')
    expect(fs.existsSync(path.join(from, 'x'))).toBe(false)
    expect(fs.existsSync(path.join(from, '.git'))).toBe(false)
    expect(() => t47.prepareT5({ runRoot: path.join(base, 'r2'), from: path.join(__dirname, '..', 'examples', 'legacy-app') })).toThrow(/legacy/)
    expect(() => t47.prepareT5({ runRoot: path.join(base, 'r3'), from: base })).toThrow(/no manifest/)
  })
})

describe('score T4', () => {
  test('good end state passes; e2e lint re-run when no exit code', () => {
    const root = tmp(); cellWith(root, 'greenfield/t4', 't4-good')
    const s = t47.score({ runRoot: root, results: { cells: { 'greenfield/t4': T4_CELL } } })
    const c = s.cells['greenfield/t4']
    expect(Object.fromEntries(Object.entries(c.criteria).map(([k, v]) => [k, v.pass]))).toEqual({ init: true, btAgent: true, scriptTags: true, ids: true, spec: true, e2eLint: true, btStore: true })
    expect(c.pass).toBe(true)
    expect(c.criteria.ids.mode).toBe('review')
    const noCode = { ...T4_CELL, exitCodes: { ...T4_CELL.exitCodes } }
    delete noCode.exitCodes['npx brighttest e2e lint flows/list-to-detail.e2e.yaml']
    const s2 = t47.score({ runRoot: root, results: { cells: { 'greenfield/t4': noCode } } })
    expect(s2.cells['greenfield/t4'].criteria.e2eLint.note).toMatch(/re-run exit 0/)
  })
  test('failures are named', () => {
    const root = tmp(), app = cellWith(root, 'greenfield/t4', 't4-good')
    fs.writeFileSync(path.join(app, 'manifest'), 'title=x\nbs_const=BT_AGENT=true\n')
    fs.writeFileSync(path.join(app, 'components', 'HomeScene.xml'), '<component name="H" extends="Scene"><children><Button text="a"/></children></component>')
    const cell = { finalMessage: 'BTStore supports time-travel debugging.', commands: [], exitCodes: { 'npx brighttest': 1 } }
    const c = t47.score({ runRoot: root, results: { cells: { 'greenfield/t4': cell } } }).cells['greenfield/t4']
    expect(c.pass).toBe(false)
    for (const k of ['init', 'btAgent', 'scriptTags', 'ids', 'spec', 'btStore']) expect(c.criteria[k].pass, k).toBe(false)
    expect(c.criteria.scriptTags.note).toMatch(/HomeScene\.brs/)
    expect(c.criteria.btStore.note).toMatch(/time-travel/)
  })
  test('btStore: negated time-travel is fine, missing BTStore fails', () => {
    expect(t47.btStore('BTStore has limits. No time-travel.').pass).toBe(true)
    expect(t47.btStore('We added tests.').pass).toBe(false)
  })
})

describe('score T5', () => {
  const run = (mutate, cell = { finalMessage: 'Device job runs on a self-hosted runner only.' }) => {
    const root = tmp(), app = cellWith(root, 'greenfield/t5', 't5-good', true)
    if (mutate) mutate(path.join(app, '.github', 'workflows', 'ci.yml'), app)
    return t47.score({ runRoot: root, results: { cells: { 'greenfield/t5': cell } } }).cells['greenfield/t5']
  }
  test('good workflow passes every criterion', () => {
    const c = run()
    expect(Object.fromEntries(Object.entries(c.criteria).map(([k, v]) => [k, v.pass]))).toEqual({ node22: true, headless: true, verifyGate: true, device: true, noWindowsDevice: true, noSecrets: true })
    expect(c.criteria.headless.mode).toBe('auto')
    expect(c.criteria.noWindowsDevice.mode).toBe('review')
  })
  test('each defect fails its own criterion', () => {
    const edit = (re, to) => (f) => fs.writeFileSync(f, read(f).replace(re, to))
    expect(run(edit(/node-version: 22/, 'node-version: 20')).criteria.node22.pass).toBe(false)
    expect(run(edit(/--lcov \\/, '\\')).criteria.headless.pass).toBe(false)
    expect(run(edit(/run: npx brighttest instrument verify dist\/app.zip/, 'run: npx brighttest instrument verify dist/app.zip || true')).criteria.verifyGate.pass).toBe(false)
    expect(run(edit(/ci:\$\{\{ github.run_id \}\}/, 'ci')).criteria.device.pass).toBe(false)
    expect(run(edit(/BRIGHTTEST_LEASE_WAIT: 600\n/, '')).criteria.device.note).toMatch(/BRIGHTTEST_LEASE_WAIT/)
    expect(run(edit(/\[self-hosted, roku\]/, '[windows-latest]')).criteria.device.pass).toBe(false)
    expect(run(edit(/\[self-hosted, roku\]/, '[self-hosted, windows]')).criteria.noWindowsDevice.pass).toBe(false)
  })
  test('secret scan flags literals, never prints them', () => {
    const lit = 'hunter2hunter2'
    const c = run((f, app) => { fs.writeFileSync(f, read(f).replace('${{ secrets.ROKU_PASSWORD }}', lit)); fs.writeFileSync(path.join(app, 'a.txt'), 'x=ghp_' + 'a'.repeat(30)) })
    expect(c.criteria.noSecrets.pass).toBe(false)
    expect(c.criteria.noSecrets.note).toMatch(/ci\.yml:\d+/)
    expect(c.criteria.noSecrets.note).toMatch(/a\.txt:1/)
    expect(JSON.stringify(c)).not.toContain(lit)
    expect(JSON.stringify(c)).not.toContain('ghp_')
  })
  test('missing workflow fails; legacy or unprepared cell is refused', () => {
    const c = run((f, app) => fs.rmSync(path.join(app, '.github'), { recursive: true }))
    expect(c.pass).toBe(false); expect(c.criteria.node22.note).toMatch(/no \.github/)
    const root = tmp(); cellWith(root, 'greenfield/t5', 't5-good', false)
    expect(() => t47.score({ runRoot: root, results: { cells: {} } })).toThrow(/prepare-t5/)
    const r2 = tmp(), app = cellWith(r2, 'greenfield/t5', 't5-good', true)
    fs.copyFileSync(path.join(__dirname, '..', 'examples', 'legacy-app', 'manifest'), path.join(app, 'manifest'))
    expect(() => t47.score({ runRoot: r2, results: { cells: {} } })).toThrow(/legacy/)
  })
})

describe('CLI', () => {
  test('prepare, prepare-t5, score write SCORE47.md and .json', () => {
    const base = tmp(), root = path.join(base, 'run'), res = path.join(base, 'res.json')
    const sh = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', timeout: 60000 })
    expect(sh('prepare', '--run-root', root).status).toBe(0)
    expect(sh('prepare-t5', '--run-root', root).status).toBe(2)
    expect(sh('prepare-t5', '--run-root', root, '--from', path.join(root, 'greenfield', 't4')).status).toBe(0)
    fs.writeFileSync(res, JSON.stringify({ cells: {} }))
    expect(sh('score', '--run-root', root, '--results', res).status).toBe(0)
    expect(read(path.join(root, 'SCORE47.md'))).toMatch(/greenfield\/t5/)
    expect(JSON.parse(read(path.join(root, 'SCORE47.json'))).cells['greenfield/t4'].pass).toBe(false)
  })
})
