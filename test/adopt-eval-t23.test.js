import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const t23 = require('../scripts/adopt-eval/t23')
const fx = (n) => { const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'adopt-eval', 't23', n), 'utf8')); return { ...j, message: j.finalMessage } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-t23-'))
const W = (app, rel, txt) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), txt) }

// prepare() spawns git three times per cell and copies the fixture four times, which is slow on Windows
// (process spawn, Defender, small-file I/O). Run it once per file; read-only tests share the tree and
// tests that edit an app copy the prepared app dir (no git spawn) into their own temp dir.
const made = []
const mk = () => { const d = tmp(); made.push(d); return d }
let shared
beforeAll(() => {
  const root = path.join(mk(), 'run')
  t23.prepare({ runRoot: root })
  shared = root
})
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  fs.rmSync(`${shared}-baseline`, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const dirOf = (root, arm, task) => path.join(arm === 'baseline' ? `${root}-baseline` : root, 'legacy-app', task)
function cells() {
  const root = shared
  return { root, t2: path.join(dirOf(root, 'with-skills', 't2'), 'app'), t3: path.join(dirOf(root, 'with-skills', 't3'), 'app'), d: (arm, task) => dirOf(root, arm, task) }
}
// Private writable copies of the with-skills apps (including .git) for tests that edit them.
function fresh() {
  const c = cells(), base = mk()
  const t2 = path.join(base, 't2'), t3 = path.join(base, 't3')
  fs.cpSync(c.t2, t2, { recursive: true })
  fs.cpSync(c.t3, t3, { recursive: true })
  return { ...c, t2, t3 }
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
  test('t2 prompt carries the Step 0 answers in both arms, t3 does not', () => {
    const c = cells()
    for (const arm of ['with-skills', 'baseline']) {
      const t2 = fs.readFileSync(path.join(c.d(arm, 't2'), 'prompt.md'), 'utf8')
      const t3 = fs.readFileSync(path.join(c.d(arm, 't3'), 'prompt.md'), 'utf8')
      expect(t2).toMatch(/Answers to the setup questions/)
      expect(t2).toMatch(/may NOT edit the app source, components, manifest or bsconfig/)
      expect(t2).toMatch(/No Roku device is available/)
      expect(t3).not.toMatch(/Answers to the setup questions/)
      expect(t3).not.toMatch(/No Roku device is available/)
    }
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
    // --clean wipes a used root (own root, two cells, so this stays cheap)
    const root = path.join(mk(), 'run'), stray = path.join(root, 'stray.txt')
    fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(stray, 'x')
    expect(() => t23.prepare({ runRoot: root })).toThrow(/not empty/)
    expect(() => t23.prepare({ runRoot: root, clean: true, tasks: ['t2'] })).not.toThrow()
    expect(fs.existsSync(stray)).toBe(false)
    expect(fs.existsSync(path.join(dirOf(root, 'with-skills', 't2'), 'app', 'manifest'))).toBe(true)
    fs.rmSync(`${root}-baseline`, { recursive: true, force: true })
  })
})

describe('T2 score', () => {
  const good = () => {
    const c = fresh()
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
    const c = fresh()
    W(c.t2, 'source/tests/OnlyOne.spec.bs', 'x')
    W(c.t2, 'brighttest.json', '{ nope')
    const g = fx('t2-good.json')
    const r = t23.scoreT2({ finalMessage: '', message: '', commands: ['npx brighttest'], exitCodes: { 'npx brighttest': 1 }, appDir: c.t2 })
    expect(r.T2a.pass).toBe(false)
    expect(r.T2b.pass).toBe(false)
    expect(r.T2c.pass).toBe(false)
    const shipped = fs.readdirSync(path.join(REPO, 'examples', 'legacy-app', 'source', 'tests')).filter((f) => /\.spec\.(bs|brs)$/.test(f)).length
    expect(r.T2c.note).toContain(`the fixture ships ${shipped};`)
    expect(r.T2d.pass).toBe(false)
    expect(r.T2f.pass).toBe(false)
    expect(r.T2g.pass).toBe(false)
    expect(t23.scoreT2({ message: g.finalMessage, commands: ['npx brighttest'], exitCodes: {}, appDir: c.t2 }).T2b.mode).toBe('review')
  })
  describe('T2d wording', () => {
    const d = (msg) => t23.scoreT2({ ...fx('t2-good.json'), message: msg, appDir: good().t2 }).T2d
    test('plain wording passes (review mode)', () => {
      const r = d('I changed one expectation from v2 to v3; the run gave 16 passed, 1 failed, exit 1, with a failure line naming the test. I restored the file and the run was green again (17 passed, exit 0)')
      expect(r.pass).toBe(true)
      expect(r.mode).toBe('review')
    })
    test('edited/modified/tweaked/altered assertion wording passes', () => {
      for (const w of ['edited the assert', 'modified one value', 'tweaked a string in a spec', 'altered the expectation']) expect(d(`I ${w}; it failed. Then I reverted it.`).pass).toBe(true)
    })
    test('failure and restore but no change or flip words fails', () => {
      expect(d('One test failed at first. I restored the environment afterwards.').pass).toBe(false)
    })
    test('flip words but no restore fails', () => {
      expect(d('I changed one expectation and the run failed with exit 1.').pass).toBe(false)
    })
    test('flip and restore but no failure mention fails', () => {
      expect(d('I changed one expectation, then restored the file.').pass).toBe(false)
    })
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
    const c = fresh()
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
