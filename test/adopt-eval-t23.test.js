import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const t23 = require('../scripts/adopt-eval/t23')
const fx = (n) => { const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'adopt-eval', 't23', n), 'utf8')); return { ...j, message: j.finalMessage } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-t23-'))
const W = (app, rel, txt) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), txt) }

function cells() {
  const root = path.join(tmp(), 'run')
  t23.prepare({ runRoot: root })
  const d = (arm, task) => path.join(arm === 'baseline' ? `${root}-baseline` : root, 'legacy-app', task)
  return { root, t2: path.join(d('with-skills', 't2'), 'app'), t3: path.join(d('with-skills', 't3'), 'app'), d }
}
const REPO = path.join(__dirname, '..')

describe('prepare', () => {
  test('makes per-arm cells in separate roots, no ground truth, no shipped skills in the app', () => {
    const c = cells()
    for (const arm of ['with-skills', 'baseline']) for (const task of ['t2', 't3']) {
      const app = path.join(c.d(arm, task), 'app')
      expect(fs.existsSync(path.join(app, 'manifest'))).toBe(true)
      expect(fs.existsSync(path.join(app, 'EXPECTED-CENSUS.json'))).toBe(false)
      expect(fs.existsSync(path.join(app, 'node_modules'))).toBe(false)
      expect(fs.existsSync(path.join(c.d(arm, task), 'out'))).toBe(true)
      expect(fs.readFileSync(path.join(c.d(arm, task), 'prompt.md'), 'utf8').split('\n')[0]).toBe(t23.PROMPTS[task])
    }
    expect(fs.existsSync(path.join(c.d('baseline', 't3'), 'app', 'README.md'))).toBe(false)
    expect(fs.existsSync(path.join(c.d('with-skills', 't3'), 'app', 'README.md'))).toBe(true)
  })
  test('with-skills prompt inlines safety, brownfield skill, references and the CLI path; baseline gets none of it', () => {
    const c = cells()
    const ws = fs.readFileSync(path.join(c.d('with-skills', 't3'), 'prompt.md'), 'utf8')
    const bl = fs.readFileSync(path.join(c.d('baseline', 't3'), 'prompt.md'), 'utf8')
    expect(ws).toContain(path.join(REPO, 'bin', 'cli.js'))
    for (const f of t23.skillFiles()) expect(ws).toContain(fs.readFileSync(f, 'utf8').trim())
    expect(t23.skillFiles().length).toBeGreaterThan(2)
    expect(ws).toMatch(/plain, non-instrumented package zip/)
    expect(bl).toMatch(/plain, non-instrumented package zip/)
    expect(bl).not.toMatch(/brighttest|cli\.js|SKILL|safety/i)
    expect(bl).toMatch(/Do not read README/)
    expect(bl).not.toContain(c.root + path.sep)
  })
  test('refuses a non-empty root without --clean, and a root inside the repo', () => {
    const c = cells()
    expect(() => t23.prepare({ runRoot: c.root })).toThrow(/not empty/)
    expect(() => t23.prepare({ runRoot: path.join(__dirname, '..', 'x') })).toThrow(/outside the repo/)
    expect(() => t23.prepare({ runRoot: c.root, clean: true })).not.toThrow()
  })
})

describe('T2 score', () => {
  const good = () => {
    const c = cells()
    for (const n of ['A', 'B', 'C']) W(c.t2, `source/tests/New${n}.spec.bs`, 'x')
    W(c.t2, '.gitignore', fs.readFileSync(path.join(c.t2, '.gitignore'), 'utf8') + '.env\n')
    return c
  }
  test('good cell passes with review on the flip', () => {
    const c = good()
    const r = t23.scoreT2({ ...fx('t2-good.json'), appDir: c.t2 })
    for (const [k, v] of Object.entries(r)) expect([k, v.pass]).toEqual([k, true])
    expect(r.T2d.mode).toBe('review')
    expect(r.T2e.mode).toBe('auto')
  })
  test('app source edit fails the allow-list', () => {
    const c = good()
    fs.appendFileSync(path.join(c.t2, 'source', 'main.brs'), "\n' edit\n")
    const r = t23.scoreT2({ ...fx('t2-good.json'), appDir: c.t2 })
    expect(r.T2e.pass).toBe(false)
    expect(r.T2e.note).toMatch(/source\/main\.brs/)
  })
  test('few specs, bad config, missing .env, no exit code, failing last run', () => {
    const c = cells()
    W(c.t2, 'source/tests/OnlyOne.spec.bs', 'x')
    W(c.t2, 'brighttest.json', '{ nope')
    const g = fx('t2-good.json')
    const r = t23.scoreT2({ finalMessage: '', message: '', commands: ['npx brighttest'], exitCodes: { 'npx brighttest': 1 }, appDir: c.t2 })
    expect(r.T2a.pass).toBe(false)
    expect(r.T2b.pass).toBe(false)
    expect(r.T2c.pass).toBe(false)
    expect(r.T2d.pass).toBe(false)
    expect(r.T2f.pass).toBe(false)
    expect(r.T2g.pass).toBe(false)
    expect(t23.scoreT2({ message: g.finalMessage, commands: ['npx brighttest'], exitCodes: {}, appDir: c.t2 }).T2b.mode).toBe('review')
  })
  test('leftover backup file in tests fails the restore check', () => {
    const c = good()
    W(c.t2, 'source/tests/NewA.spec.bs.orig', 'x')
    expect(t23.scoreT2({ message: fx('t2-good.json').finalMessage, ...fx('t2-good.json'), appDir: c.t2 }).T2d.pass).toBe(false)
  })
})

describe('T3 score', () => {
  test('good cell passes; strict stays a review item', () => {
    const c = cells()
    const r = t23.scoreT3({ message: fx('t3-good.json').finalMessage, ...fx('t3-good.json'), appDir: c.t3 })
    for (const [k, v] of Object.entries(r)) expect([k, v.pass]).toEqual([k, true])
    expect(r.T3e.mode).toBe('review')
  })
  test('strict explanation phrased as off-first-then-turn-on counts as explained', () => {
    const c = cells()
    const g = fx('t3-good.json')
    const message = 'Strict stays off for the first build so a package is always produced; turn it on in CI once a build with --strict exits 0.'
    const r = t23.scoreT3({ message, commands: g.commands, exitCodes: g.exitCodes, appDir: c.t3 })
    expect(r.T3e.pass).toBe(true)
    expect(r.T3e.mode).toBe('review')
  })
  test('wrong verify codes, alias, strict on, missing --out, app edit', () => {
    const c = cells()
    const g = fx('t3-good.json')
    W(c.t3, 'brighttest.json', JSON.stringify({ instrumentExclude: ['a'], instrument: { strict: true } }))
    fs.appendFileSync(path.join(c.t3, 'source', 'main.brs'), '\n')
    const ex = { ...g.exitCodes, 'node bin/cli.js instrument verify /x/debug.zip': 0 }
    const r = t23.scoreT3({ message: g.finalMessage, commands: g.commands.filter((x) => !/init/.test(x)).map((x) => x.replace(' --out /x/debug.zip', '')), exitCodes: ex, appDir: c.t3 })
    expect(r.T3a.pass).toBe(false)
    expect(r.T3b.pass).toBe(false)
    expect(r.T3c.pass).toBe(false)
    expect(r.T3d.pass).toBe(false)
    expect(r.T3e.pass).toBe(false)
    expect(r.T3f.pass).toBe(false)
  })
})

describe('score and render', () => {
  test('missing cells fail the gate', () => {
    const c = cells()
    const s = t23.score({ runRoot: c.root, results: { cells: { 'legacy-app/with-skills/t3': fx('t3-good.json') } } })
    expect(s.arms['with-skills'].t2.pass).toBe(false)
    expect(s.gate).toBe(false)
    expect(t23.render(s)).toMatch(/No result for this cell/)
  })
  test('both arms scored per task; contaminated baseline excluded; only with-skills gates', () => {
    const c = cells()
    const g = fx('t3-good.json')
    const dirty = { ...g, commands: [...g.commands, 'cat node_modules/brighttest/skills/x/SKILL.md'], reads: [] }
    const s = t23.score({ runRoot: c.root, tasks: ['t3'], results: { cells: { 'legacy-app/with-skills/t3': g, 'legacy-app/baseline/t3': dirty } } })
    expect(s.arms['with-skills'].t3.pass).toBe(true)
    expect(s.arms.baseline.t3.excluded).toBe(true)
    expect(s.contaminated[0].cell).toBe('legacy-app/baseline/t3')
    expect(s.gate).toBe(true)
    expect(t23.render(s)).toMatch(/Contaminated baseline cell/)
  })
  test('a clean baseline is scored, and naming the app own brighttest.json is not contamination', () => {
    const c = cells()
    const r = { finalMessage: 'No tool; built a zip.', commands: ['cat brighttest.json', 'zip -r ../out/p.zip .'], exitCodes: {} }
    const s = t23.score({ runRoot: c.root, tasks: ['t3'], results: { cells: { 'legacy-app/with-skills/t3': fx('t3-good.json'), 'legacy-app/baseline/t3': r } } })
    expect(s.arms.baseline.t3.present).toBe(true)
    expect(s.arms.baseline.t3.excluded).toBeUndefined()
    expect(s.arms.baseline.t3.pass).toBe(false)
    expect(s.contaminated).toEqual([])
  })
})
