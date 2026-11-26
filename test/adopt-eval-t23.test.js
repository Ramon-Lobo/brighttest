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

// T3a needs the app's brighttest.json as init --brownfield would leave it: run the real merge on a private copy.
function merged(app) {
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(REPO, 'bin', 'cli.js'), 'init', '--brownfield'], { cwd: app, encoding: 'utf8', timeout: 120000 })
  expect(r.status).toBe(0)
}
// A private run root (both arms) whose with-skills t3 app has been through the real merge.
function mergedRoot() {
  const root = path.join(mk(), 'run')
  fs.cpSync(shared, root, { recursive: true })
  fs.cpSync(`${shared}-baseline`, `${root}-baseline`, { recursive: true })
  made.push(`${root}-baseline`)
  merged(path.join(dirOf(root, 'with-skills', 't3'), 'app'))
  return root
}
describe('T3a (init --brownfield against the existing config)', () => {
  const g = () => fx('t3-good.json')
  const a = (c, o = {}) => t23.scoreT3({ message: g().finalMessage, commands: g().commands, exitCodes: g().exitCodes, appDir: c.t3, ...o }).T3a
  test('pass: init ran and the merged file is valid with original keys unchanged', () => {
    const c = fresh(); merged(c.t3)
    expect(a(c).pass).toBe(true)
  })
  test('fail: init skipped (or only --dry-run) even though the final file is valid', () => {
    const c = fresh(); merged(c.t3)
    expect(a(c, { commands: g().commands.filter((x) => !/init/.test(x)) }).pass).toBe(false)
    expect(a(c, { commands: g().commands.map((x) => x.replace('--brownfield', '--brownfield --dry-run')) }).pass).toBe(false)
  })
  test('fail: the presence-only file (fixture untouched, no strict key) is incomplete', () => {
    const c = fresh()
    const r = a(c)
    expect(r.pass).toBe(false)
    expect(r.note).toMatch(/instrument\.strict/)
  })
  test('fail: init overwrote keys that were valid before', () => {
    const c = fresh(); merged(c.t3)
    const cfg = JSON.parse(fs.readFileSync(path.join(c.t3, 'brighttest.json'), 'utf8'))
    cfg.instrument.state.registrySections = ['other']
    W(c.t3, 'brighttest.json', JSON.stringify(cfg))
    const r = a(c)
    expect(r.pass).toBe(false)
    expect(r.note).toMatch(/instrument\.state/)
  })
  test('fail: final file invalid or unparseable', () => {
    const c = fresh(); merged(c.t3)
    const cfg = JSON.parse(fs.readFileSync(path.join(c.t3, 'brighttest.json'), 'utf8'))
    cfg.rootDir = 3
    W(c.t3, 'brighttest.json', JSON.stringify(cfg))
    expect(a(c).note).toMatch(/invalid or incomplete: rootDir/)
    W(c.t3, 'brighttest.json', '{ nope')
    expect(a(c).pass).toBe(false)
  })
  test('init exit code nonzero fails', () => {
    const c = fresh(); merged(c.t3)
    const cmd = g().commands[0]
    expect(a(c, { exitCodes: { ...g().exitCodes, [cmd]: 1 } }).pass).toBe(false)
  })
})

// init works in its cwd, so an agent that honours "this app must not be edited" runs it in a copy next to app/.
describe('T3a where init ran (a copy of the app)', () => {
  const g = () => fx('t3-good.json')
  const cp = (c, rel) => { const d = path.join(path.dirname(c.t3), rel); fs.cpSync(c.t3, d, { recursive: true }); return d }
  const a = (c, o = {}) => t23.scoreT3({ message: g().finalMessage, commands: g().commands, exitCodes: g().exitCodes, appDir: c.t3, ...o }).T3a
  const orig = (c) => fs.readFileSync(path.join(c.t3, 'brighttest.json'), 'utf8')
  const read = (d) => JSON.parse(fs.readFileSync(path.join(d, 'brighttest.json'), 'utf8'))

  test('pass: init in place (app/ holds the .bak)', () => {
    const c = fresh(); merged(c.t3)
    expect(a(c).pass).toBe(true)
  })
  test('pass: init in work/ with a valid merge; original app untouched and T3f still passes', () => {
    const c = fresh(), before = orig(c), work = cp(c, 'work'); merged(work)
    const r = t23.scoreT3({ message: g().finalMessage, commands: g().commands, exitCodes: g().exitCodes, appDir: c.t3 })
    expect(r.T3a.pass).toBe(true)
    expect(r.T3a.note).toMatch(/work/)
    expect(orig(c)).toBe(before)
    expect(r.T3f.pass).toBe(true)
  })
  test('pass: init in out/app-work (nested copy)', () => {
    const c = fresh(), d = cp(c, path.join('out', 'app-work')); merged(d)
    expect(a(c).pass).toBe(true)
  })
  test('pass: `cd <dir> &&` prefix and a recorded cwd name the directory', () => {
    const c = fresh(), d = cp(c, 'elsewhere'); merged(d)
    const cmd = g().commands[0]
    expect(a(c, { commands: [`cd ${d} && ${cmd}`, ...g().commands.slice(1)], exitCodes: {} }).pass).toBe(true)
    expect(a(c, { cwds: { [cmd]: 'elsewhere' } }).pass).toBe(true)
  })
  test('fail: init in a copy whose result is invalid', () => {
    const c = fresh(), work = cp(c, 'work'); merged(work)
    const cfg = read(work); cfg.rootDir = 3
    W(work, 'brighttest.json', JSON.stringify(cfg))
    const r = a(c)
    expect(r.pass).toBe(false)
    expect(r.note).toMatch(/invalid or incomplete: rootDir/)
  })
  test('fail: init in a copy that altered an originally valid key', () => {
    const c = fresh(), work = cp(c, 'work'); merged(work)
    const cfg = read(work); cfg.instrument.state.registrySections = ['other']
    W(work, 'brighttest.json', JSON.stringify(cfg))
    const r = a(c)
    expect(r.pass).toBe(false)
    expect(r.note).toMatch(/instrument\.state/)
  })
  test('fail: only a dry run, or no init at all, even with a valid merged copy', () => {
    const c = fresh(), work = cp(c, 'work'); merged(work)
    expect(a(c, { commands: g().commands.map((x) => x.replace('--brownfield', '--brownfield --dry-run')) }).pass).toBe(false)
    expect(a(c, { commands: g().commands.filter((x) => !/init/.test(x)) }).note).toMatch(/no `init --brownfield` run/)
  })
  test('fail with a message: two directories hold a .bak, or the named directory has no brighttest.json', () => {
    const c = fresh(); merged(cp(c, 'work')); merged(cp(c, 'other'))
    const amb = a(c)
    expect(amb.pass).toBe(false)
    expect(amb.note).toMatch(/cannot tell where init --brownfield ran/)
    const cmd = g().commands[0]
    const missing = a(c, { commands: [`cd nowhere && ${cmd}`, ...g().commands.slice(1)], exitCodes: {} })
    expect(missing.pass).toBe(false)
    expect(missing.note).toMatch(/has no brighttest\.json/)
  })
  test('fail: agent commits after init in place and altered a valid key (HEAD must not be the baseline)', () => {
    const c = fresh(); merged(c.t3)
    const cfg = read(c.t3); cfg.instrument.state.registrySections = ['other']
    W(c.t3, 'brighttest.json', JSON.stringify(cfg))
    const git = (...x) => require('node:child_process').spawnSync('git', ['-c', 'user.name=e', '-c', 'user.email=e@e.invalid', '-c', 'commit.gpgsign=false', ...x], { cwd: c.t3, encoding: 'utf8' })
    git('add', '-A'); git('commit', '-q', '-m', 'after init')
    const r = a(c)
    expect(r.pass).toBe(false)
    expect(r.note).toMatch(/instrument\.state/)
  })
  test('pass: compound `init --brownfield --dry-run && init --brownfield` and `cd work && init --brownfield`', () => {
    const c = fresh(), d = cp(c, 'work'); merged(d)
    const init = g().commands[0], rest = g().commands.slice(1)
    expect(a(c, { commands: [`${init} --dry-run && ${init}`, ...rest], exitCodes: {} }).pass).toBe(true)
    expect(a(c, { commands: [`cd work && ${init}`, ...rest], exitCodes: {} }).pass).toBe(true)
    expect(a(c, { commands: [`${init} --dry-run\n${init}`, ...rest], exitCodes: {} }).pass).toBe(true)
  })
  test('compound with only a dry-run still fails', () => {
    const c = fresh(), init = g().commands[0]
    merged(c.t3)
    expect(a(c, { commands: [`${init} --dry-run && echo ok`, ...g().commands.slice(1)] }).pass).toBe(false)
  })
  test('unrecorded init exit code is unknown: reported, passes only if the config checks pass', () => {
    const c = fresh(); merged(c.t3)
    const ok = a(c, { exitCodes: {} })
    expect(ok.pass).toBe(true)
    expect(ok.mode).toBe('review')
    expect(ok.note).toMatch(/exit code not recorded/)
    const bad = a(fresh(), { exitCodes: {} })
    expect(bad.pass).toBe(false)
    expect(bad.note).toMatch(/exit code not recorded/)
  })
  test('fail: init ran in a copy but changed nothing visible (no .bak): app/ is scored and is incomplete', () => {
    const c = fresh(); cp(c, 'work')
    expect(a(c).pass).toBe(false)
  })
})

describe('T3 score', () => {
  test('good cell passes; strict stays a review item', () => {
    const c = fresh(); merged(c.t3)
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
    const c = { root: mergedRoot() }
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
