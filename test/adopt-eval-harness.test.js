import { describe, test, expect, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { prepare } = require('../scripts/adopt-eval/prepare')
const common = require('../scripts/adopt-eval/common')
const sc = require('../scripts/adopt-eval/score')

const made = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-eval-')); made.push(d, `${d}/run-baseline`, `${d}/x-baseline`); return d }
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
const cd = (root, fx, arm, run) => common.cellDir(root, fx, arm, run)

describe('prepare', () => {
  test('makes 12 cells with git-initialised app copies, no ground truth', () => {
    const root = path.join(tmp(), 'run')
    const r = prepare({ runRoot: root })
    expect(r.cells).toHaveLength(12)
    const app = path.join(cd(root, 'legacy-app', 'baseline', 1), 'app')
    expect(fs.existsSync(path.join(app, 'manifest'))).toBe(true)
    expect(fs.existsSync(path.join(app, 'EXPECTED-CENSUS.json'))).toBe(false)
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: app, encoding: 'utf8' }).stdout).toBe('')
    expect(fs.existsSync(path.join(cd(root, 'bsconfig-plugin-app', 'with-skills', 3), 'prompt.md'))).toBe(true)
  })
  test('refuses non-empty root unless --clean; refuses root inside repo', () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'x'), '1')
    expect(() => prepare({ runRoot: root })).toThrow(/not empty/)
    expect(prepare({ runRoot: root, clean: true }).cells).toHaveLength(12)
    expect(() => prepare({ runRoot: path.join(common.REPO_ROOT, 'scratch-x') })).toThrow(/outside the repo/)
  })
})

describe('prompt build', () => {
  const base = common.buildPrompt({ arm: 'baseline', appDir: '/x/app', reportPath: '/x/report.md' })
  const skills = common.buildPrompt({ arm: 'with-skills', appDir: '/x/app', reportPath: '/x/report.md' })
  test('baseline has only the task prompt and paths', () => {
    expect(base).toContain(common.TASK_PROMPT)
    expect(base.replace(common.TASK_PROMPT, "")).not.toMatch(/cli\.js|SKILL|skill|assessing-a-roku-app|safety|assess\b/i)
    expect(base.match(/brighttest/gi)).toHaveLength(1) // only the task prompt
  })
  test('with-skills inlines skill text and CLI path', () => {
    const skill = fs.readFileSync(common.SKILL_FILES[1], 'utf8').trim()
    expect(skills).toContain(skill)
    expect(skills).toContain(fs.readFileSync(common.SKILL_FILES[0], 'utf8').trim())
    expect(skills).toContain(path.join(common.REPO_ROOT, 'bin', 'cli.js') + ' assess')
  })
})

describe('score', () => {
  test('threshold math', () => {
    expect(sc.threshold(5)).toBe(4)
    expect(sc.threshold(6)).toBe(5)
  })
  const mk = (p) => ({ pass: p, mode: 'auto', note: '' })
  const runWith = (fails) => Object.fromEntries(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((c) => [c, mk(!fails.includes(c))]))
  test('2-of-3 rule and 5 of 6 / 4 of 5 verdicts', () => {
    // plugin: C4 not applicable -> 5 applicable, need 4. C1 fails in all runs -> 4/5 passes
    const pl = sc.aggregate('bsconfig-plugin-app', [runWith(['C1']), runWith(['C1']), runWith(['C1'])])
    expect(pl.applicable).toBe(5); expect(pl.criteria.C4).toBeUndefined(); expect(pl.pass).toBe(true)
    // two criteria fail -> 3/5 fails
    expect(sc.aggregate('bsconfig-plugin-app', [runWith(['C1', 'C2']), runWith(['C1', 'C2']), runWith([])]).pass).toBe(false)
    // a C4 failure on the plugin fixture is ignored
    expect(sc.aggregate('bsconfig-plugin-app', [runWith(['C4']), runWith(['C4']), runWith(['C4'])]).pass).toBe(true)
    // C1 passes in exactly 2 of 3 runs -> criterion passes
    const a = sc.aggregate('bsconfig-plugin-app', [runWith([]), runWith([]), runWith(['C1'])])
    expect(a.criteria.C1.pass).toBe(true)
    expect(a.criteria.C1.passes).toBe(2)
    // legacy: C3 excluded, 5 applicable, one failing criterion -> 4/5 passes
    const l = sc.aggregate('legacy-app', [runWith(['C2']), runWith(['C2']), runWith(['C2'])])
    expect(l.applicable).toBe(5)
    expect(l.criteria.C3).toBeUndefined()
    expect(l.pass).toBe(true)
    expect(sc.aggregate('legacy-app', [runWith(['C2', 'C4']), runWith(['C2', 'C4']), runWith(['C2', 'C4'])]).pass).toBe(false)
  })
  test('scoreRun on a good legacy answer, and a bad one', () => {
    const app = tmp()
    spawnSync('git', ['init', '-q'], { cwd: app })
    fs.writeFileSync(path.join(app, 'a'), '1')
    spawnSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b.c', 'add', '-A'], { cwd: app })
    spawnSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-q', '-m', 'x'], { cwd: app })
    const good = 'Census: 32 brs files, 56 xml files, 56 components, 3 tasks. Inline CDATA scripts, vendor exclusion, render-thread risk. May I edit the app? Do you have a Roku device available?'
    const r = sc.scoreRun({ fixture: 'legacy-app', message: good, commands: ['node /r/bin/cli.js assess /a'], appDir: app })
    expect(r.C1.pass).toBe(true); expect(r.C2.pass).toBe(true); expect(r.C3).toBeNull()
    expect(r.C4.pass).toBe(true); expect(r.C5.pass).toBe(true); expect(r.C5.mode).toBe('review'); expect(r.C6.pass).toBe(true)
    fs.writeFileSync(path.join(app, 'a'), '2')
    const bad = sc.scoreRun({ fixture: 'legacy-app', message: '40 xml files. Nothing else.', appDir: app })
    expect(bad.C1.pass).toBe(false); expect(bad.C2.pass).toBe(false); expect(bad.C4.pass).toBe(false)
    expect(bad.C5.pass).toBe(false); expect(bad.C6.pass).toBe(false)
  })
  test('C3 on plugin app', () => {
    const app = tmp()
    const r = sc.scoreRun({ fixture: 'bsconfig-plugin-app', message: 'bsconfig.json has rootDir src, a blocker', appDir: app })
    expect(r.C3.pass).toBe(true)
  })
})

// Excerpts below are generic phrasings taken from the real T1 results.json (legacy-app and bsconfig-plugin-app fixtures).
const gitApp = () => {
  const app = tmp()
  spawnSync('git', ['init', '-q'], { cwd: app })
  fs.writeFileSync(path.join(app, 'a'), '1')
  const g = ['-c', 'user.name=a', '-c', 'user.email=a@b.c']
  spawnSync('git', [...g, 'add', '-A'], { cwd: app })
  spawnSync('git', [...g, 'commit', '-q', '-m', 'x'], { cwd: app })
  return app
}
const EXCERPTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'adopt-eval', 't1-excerpts.json'), 'utf8'))

describe('score mechanics', () => {
  const legacyHeadline = '- Project: 32 .brs, 4 .bs, 56 .xml; 4 existing specs.\n- Census: 56 components, 6 scenes, 3 tasks; 1 dynamic CreateObject; 3 certificate calls.'
  test('C2 matches "<n> .brs", "<n> .xml" and "N brs files" in either order', () => {
    expect(sc.numbersFor('brsFiles', legacyHeadline)).toContain(32)
    expect(sc.numbersFor('xmlFiles', legacyHeadline)).toContain(56)
    expect(sc.numbersFor('brsFiles', 'we found 32 brs files')).toContain(32)
    expect(sc.numbersFor('xmlFiles', 'xml files: 56')).toContain(56)
    expect(sc.numbersFor('xmlFiles', 'Files: 1 .brs, 0 .bs, 1 .xml')).toContain(1)
    // file names are not counts
    expect(sc.numbersFor('xmlFiles', 'see 3 DemoScene.xml')).toEqual([])
  })
  test('C2 passes the legacy headline and the plugin "1 .brs, 0 .bs, 1 .xml" line; still fails a wrong count', () => {
    const app = gitApp()
    const t = { brsFiles: 32, xmlFiles: 56, components: 56, tasks: 3 }
    expect(sc.scoreRun({ fixture: 'legacy-app', message: legacyHeadline, appDir: app }).C2.pass).toBe(true)
    expect(sc.scoreRun({ fixture: 'bsconfig-plugin-app', message: 'Summary: 1 .brs, 0 .bs, 1 .xml; 1 scene, 0 tasks', appDir: app }).C2.pass).toBe(true)
    expect(sc.scoreRun({ fixture: 'legacy-app', message: legacyHeadline.replace('32 .brs', '30 .brs'), appDir: app }).C2.pass).toBe(false)
    expect(t.brsFiles).toBe(32)
  })
  test('C5 does not split on .gitignore dots and accepts edit/edited/editing; reads report.md too', () => {
    const app = gitApp()
    const q1 = 'May the team edit app code, bsconfig, .gitignore? Do you have a Roku device available?'
    expect(sc.questionsIn(q1)).toHaveLength(2)
    expect(sc.scoreRun({ fixture: 'legacy-app', message: q1, appDir: app }).C5.pass).toBe(true)
    for (const w of ['edited', 'editing']) {
      const m = `Questions: Can anything be ${w} in app/? Is a Roku device attached?`
      expect(sc.scoreRun({ fixture: 'legacy-app', message: m, appDir: app }).C5.pass).toBe(true)
    }
    // questions only in report.md
    expect(sc.scoreRun({ fixture: 'legacy-app', message: 'see report', report: q1, appDir: app }).C5.pass).toBe(true)
    // statement without a question mark still fails
    expect(sc.scoreRun({ fixture: 'legacy-app', message: 'Please confirm edit permission and the device.', appDir: app }).C5.pass).toBe(false)
  })
  test('C1 reads the report as well as the reply', () => {
    expect(sc.scoreRun({ fixture: 'legacy-app', message: 'done', report: 'ran node /r/bin/cli.js assess .', appDir: gitApp() }).C1.pass).toBe(true)
  })
  test('C4 is legacy-only: null on the plugin fixture', () => {
    const app = gitApp()
    expect(sc.scoreRun({ fixture: 'bsconfig-plugin-app', message: 'no risky patterns', appDir: app }).C4).toBeNull()
    expect(sc.scoreRun({ fixture: 'legacy-app', message: 'no risky patterns', appDir: app }).C4.pass).toBe(false)
    expect(sc.applicable('bsconfig-plugin-app')).not.toContain('C4')
    expect(sc.applicable('legacy-app')).toContain('C4')
  })
  test('contamination detects assess runs and README reads from commands/reads', () => {
    expect(sc.contamination({ commands: ['node /x/bin/cli.js assess .'] }).why).toContain('ran assess')
    expect(sc.contamination({ message: 'clean', reads: ['/app/README.md'] }).why).toEqual(['read README'])
    expect(sc.contamination({ message: 'Counted files by hand.', commands: ['find . -name "*.brs"'] })).toEqual({ why: [], review: [] })
  })
  test('score() excludes contaminated baseline cells and lists them', () => {
    const root = path.join(tmp(), 'run')
    prepare({ runRoot: root })
    const cells = { 'legacy-app/baseline/run1': { finalMessage: 'done', commands: ['npx brighttest@latest assess .'] }, 'legacy-app/baseline/run2': { finalMessage: 'plain read, nothing special' } }
    const out = sc.score({ runRoot: root, results: { cells } })
    expect(out.contaminated).toEqual([{ cell: 'legacy-app/baseline/run1', why: ['ran assess', 'used tool material'] }])
    expect(out.fixtures['legacy-app/baseline'].criteria.C1.runs[0]).toBe(sc.EXCLUDED)
    expect(sc.render(out)).toContain('Contaminated baseline cells')
  })
  test('redacted T1 excerpts (hermetic): legacy C2/C4/C5-edit and plugin C2/C3 pass', () => {
    const app = gitApp()
    const m = EXCERPTS['legacy-app/with-skills/run1']
    const l = sc.scoreRun({ fixture: 'legacy-app', message: m, appDir: app })
    expect(l.C2.pass).toBe(true); expect(l.C4.pass).toBe(true)
    expect(sc.questionsIn(m).some((q) => /\bedit(?:s|ed|ing)?\b/i.test(q))).toBe(true)
    const p = sc.scoreRun({ fixture: 'bsconfig-plugin-app', message: EXCERPTS['bsconfig-plugin-app/with-skills/run3'], appDir: app })
    expect(p.C2.pass).toBe(true); expect(p.C3.pass).toBe(true); expect(p.C4).toBeNull()
  })
  test('C2 fails when a contradicting value sits next to the right one, and ignores brs-node versions', () => {
    const app = gitApp()
    expect(sc.scoreRun({ fixture: 'legacy-app', message: legacyHeadline + ' Also 30 .brs in total.', appDir: app }).C2.pass).toBe(false)
    expect(sc.numbersFor('brsFiles', 'brs-node 2.2.0 installed')).toEqual([])
    expect([...new Set(sc.numbersFor('brsFiles', 'engines: brs-node 2.2.0; 1 .brs, 1 .xml'))]).toEqual([1])
    expect(sc.numbersFor('brsFiles', 'brs files: 32')).toContain(32)
    expect(sc.scoreRun({ fixture: 'bsconfig-plugin-app', message: 'brs-node 2.2.0; 1 .brs, 0 .bs, 1 .xml', appDir: app }).C2.pass).toBe(true)
  })
  test('README contamination needs a first-person read action in text (review only) or a command', () => {
    const c = (message, o = {}) => sc.contamination({ message, ...o })
    expect(c('You should add a README section about setup.')).toEqual({ why: [], review: [] })
    expect(c('The app has no README.')).toEqual({ why: [], review: [] })
    expect(c('I did not read the README.')).toEqual({ why: [], review: [] })
    expect(c('Do not read the README; read the manifest.')).toEqual({ why: [], review: [] })
    expect(c('I read the README first.')).toEqual({ why: [], review: ['text says README was read'] })
    expect(c('x', { commands: ['cat README.md'] }).why).toEqual(['read README'])
  })
  test('contamination: tool material in commands/reads excludes; text advice only reviews', () => {
    const c = (o) => sc.contamination(o)
    for (const cmd of ['npx brighttest doctor', 'node /r/bin/cli.js lint', 'bt scan .', 'cat ../../with-skills/run1/prompt.md', 'cat /r/skills/assessing-a-roku-app/SKILL.md', 'ls /r/docs/', 'ls node_modules/brighttest']) {
      expect(c({ commands: [cmd] }).why.length, cmd).toBeGreaterThan(0)
    }
    for (const rd of ['/r/skills/x.md', '/r/docs/guide.md', '/r/node_modules/brighttest/package.json', '/w/prompt.md', '/r/SKILL.md']) {
      expect(c({ reads: [rd] }).why.length, rd).toBeGreaterThan(0)
    }
    expect(c({ commands: ['grep -rn bt_ app/'] }).why).toEqual([])
    // advice and denials in text never exclude
    expect(c({ message: 'You could run npx brighttest@latest assess to get a census.' })).toEqual({ why: [], review: ['assess mentioned in text, no command record'] })
    expect(c({ message: 'I did not run brighttest assess; I counted by hand.' }).why).toEqual([])
    expect(c({ message: 'ran it', commands: ['npx brighttest@latest assess .'] }).why).toContain('ran assess')
  })
  test('@version after the tool name is accepted in the assess text pattern', () => {
    expect(sc.scoreRun({ fixture: 'legacy-app', message: 'I ran npx brighttest@latest assess .', appDir: gitApp() }).C1).toMatchObject({ pass: true, mode: 'review' })
  })
  test('score() keeps text-only hits in the baseline score and lists them for review', () => {
    const root = path.join(tmp(), 'run')
    prepare({ runRoot: root })
    const out = sc.score({ runRoot: root, results: { cells: { 'legacy-app/baseline/run1': { finalMessage: 'I read the README first.' } } } })
    expect(out.contaminated).toEqual([])
    expect(out.contamReview).toEqual([{ cell: 'legacy-app/baseline/run1', why: ['text says README was read'] }])
    expect(out.fixtures['legacy-app/baseline'].criteria.C1.runs[0]).not.toBe(sc.EXCLUDED)
    expect(sc.render(out)).toContain('review by hand')
  })
  test('C2 qualifiers, versions and spec listings do not count; contradiction beside the truth is review', () => {
    const app = gitApp()
    const head = '32 .brs, 56 .xml. 56 components, 3 tasks.'
    for (const extra of [' 6 scene components.', ' The 3 task components use roUrlTransfer.', ' 4 existing .brs spec files.', ' Spec files: 4 .bs, 0 .brs.', ' Rooibos v5 components']) {
      const r = sc.scoreRun({ fixture: 'legacy-app', message: head + extra, appDir: app }).C2
      expect(r.pass, extra).toBe(true)
    }
    const mixed = sc.scoreRun({ fixture: 'legacy-app', message: head + ' Also 30 .brs in total.', appDir: app }).C2
    expect(mixed).toMatchObject({ pass: false, mode: 'review' })
    const wrong = sc.scoreRun({ fixture: 'legacy-app', message: '30 .brs, 56 .xml. 56 components, 3 tasks.', appDir: app }).C2
    expect(wrong).toMatchObject({ pass: false, mode: 'auto' })
    expect(sc.numbersFor('xmlFiles', 'v5 .xml')).toEqual([])
  })
  test('C2 label form "brs: 32"', () => {
    expect(sc.numbersFor('brsFiles', 'brs: 32')).toEqual([32])
  })
  test('C5 sentence split ignores e.g./i.e./etc. and dots inside parentheses', () => {
    expect(sc.questionsIn('Is a Roku device (e.g. Roku Ultra) attached?')).toEqual(['Is a Roku device (e.g. Roku Ultra) attached?'])
    expect(sc.questionsIn('Is a device (i.e. a box) attached?')).toHaveLength(1)
    expect(sc.questionsIn('Any devices, e.g. sticks, etc. available? Fine.')).toHaveLength(1)
    expect(sc.questionsIn('One. Is it ok? Two.')).toEqual(['Is it ok?'])
    const m = 'May I edit files? Is a Roku device (e.g. Roku Ultra) attached?'
    expect(sc.scoreRun({ fixture: 'legacy-app', message: m, appDir: gitApp() }).C5.pass).toBe(true)
  })
  test('aggregate: 1 scored of 1 (others excluded) uses the scored denominator; SCORE.md shows it', () => {
    const mk = (p) => ({ pass: p, mode: 'auto', note: '' })
    const ok = Object.fromEntries(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((c) => [c, mk(true)]))
    const agg = sc.aggregate('legacy-app', [ok, sc.EXCLUDED, sc.EXCLUDED])
    expect(agg.criteria.C1).toMatchObject({ passes: 1, scored: 1, pass: true })
    expect(agg.pass).toBe(true)
    const none = sc.aggregate('legacy-app', [Object.fromEntries(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((c) => [c, mk(false)])), sc.EXCLUDED, sc.EXCLUDED])
    expect(none.criteria.C1).toMatchObject({ passes: 0, scored: 1, pass: false })
    const md = sc.render({ caveats: [], contaminated: [], gate: true, fixtures: { 'legacy-app/baseline': { fixture: 'legacy-app', arm: 'baseline', meta: [], ...agg } } })
    expect(md).toContain('| 1/1 |')
    expect(md).not.toContain('1/3')
  })
  test('arms have separate roots: baseline cells are not under the with-skills tree', () => {
    const root = path.join(tmp(), 'run')
    prepare({ runRoot: root })
    const base = cd(root, 'legacy-app', 'baseline', 1), ws = cd(root, 'legacy-app', 'with-skills', 1)
    expect(path.relative(root, base).startsWith('..')).toBe(true)
    expect(base.startsWith(root + path.sep)).toBe(false)
    expect(fs.existsSync(path.join(ws, 'prompt.md'))).toBe(true)
    // nothing reachable by walking up from the baseline cell to the baseline root contains with-skills text
    const skillText = fs.readFileSync(common.SKILL_FILES[1], 'utf8').trim().slice(0, 80)
    const baseRoot = common.armRoot(root, 'baseline')
    const files = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const f = path.join(d, e.name); e.isDirectory() ? walk(f) : files.push(f) } }
    walk(baseRoot)
    for (const f of files) expect(fs.readFileSync(f, 'utf8').includes(skillText), f).toBe(false)
  })
  test('contaminated runs leave the denominator; all excluded -> n/a', () => {
    const mk = (p) => ({ pass: p, mode: 'auto', note: '' })
    const ok = Object.fromEntries(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((c) => [c, mk(true)]))
    const bad = Object.fromEntries(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((c) => [c, mk(false)]))
    // 1 pass + 1 fail + 1 excluded -> 1 of 2 -> criterion fails; 2 pass + 1 excluded -> passes
    expect(sc.aggregate('legacy-app', [ok, bad, sc.EXCLUDED]).criteria.C1.pass).toBe(false)
    expect(sc.aggregate('legacy-app', [ok, ok, sc.EXCLUDED]).pass).toBe(true)
    // a missing result (null) still counts as a non-pass
    expect(sc.aggregate('legacy-app', [ok, null, sc.EXCLUDED]).criteria.C1.pass).toBe(false)
    const none = sc.aggregate('legacy-app', [sc.EXCLUDED, sc.EXCLUDED, sc.EXCLUDED])
    expect(none.pass).toBeNull(); expect(none.applicable).toBe(0)
  })
})

describe('prepare and prompt', () => {
  test('with-skills prompt inlines every references/* file', () => {
    const p = common.buildPrompt({ arm: 'with-skills', appDir: '/x/app', reportPath: '/x/report.md' })
    const dir = path.join(common.REPO_ROOT, 'skills', 'assessing-a-roku-app', 'references')
    const refs = fs.readdirSync(dir)
    expect(refs.length).toBeGreaterThan(0)
    for (const f of refs) {
      expect(p).toContain(`--- assessing-a-roku-app/references/${f} ---`)
      expect(p).toContain(fs.readFileSync(path.join(dir, f), 'utf8').trim())
    }
  })
  test('both arms ask for the report in the final reply; baseline carries isolation rules, with-skills does not', () => {
    const b = common.buildPrompt({ arm: 'baseline', appDir: '/x/app', reportPath: '/x/report.md' })
    const w = common.buildPrompt({ arm: 'with-skills', appDir: '/x/app', reportPath: '/x/report.md' })
    expect(b).toContain(common.REPLY_RULE); expect(w).toContain(common.REPLY_RULE)
    expect(b).toContain(common.BASELINE_RULES); expect(w).not.toContain(common.BASELINE_RULES)
    expect(b).toContain(common.TASK_PROMPT); expect(w).toContain(common.TASK_PROMPT)
  })
  test('baseline app copies have no README; with-skills copies keep it', () => {
    const root = path.join(tmp(), 'run')
    prepare({ runRoot: root })
    for (const fx of ['legacy-app', 'bsconfig-plugin-app']) {
      expect(fs.existsSync(path.join(cd(root, fx, 'baseline', 1), 'app', 'README.md'))).toBe(false)
      expect(fs.existsSync(path.join(cd(root, fx, 'with-skills', 1), 'app', 'README.md'))).toBe(true)
    }
  })
  test('baseline arm has no node_modules and no brighttest skills anywhere in the prepared app', () => {
    // a fixture with an installed copy of the shipped skills must not leak them into the baseline cell
    const repo = path.join(tmp(), 'repo')
    for (const fx of ['legacy-app', 'bsconfig-plugin-app']) {
      fs.cpSync(path.join(common.REPO_ROOT, 'examples', fx), path.join(repo, 'examples', fx), { recursive: true })
      const leak = path.join(repo, 'examples', fx, 'node_modules', 'brighttest', 'skills', 'assessing-a-roku-app')
      fs.mkdirSync(leak, { recursive: true })
      fs.writeFileSync(path.join(leak, 'SKILL.md'), '# leaked skill\n')
    }
    fs.cpSync(path.join(common.REPO_ROOT, 'skills'), path.join(repo, 'skills'), { recursive: true })
    const root = path.join(tmp(), 'run')
    prepare({ runRoot: root, repoRoot: repo })
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? [path.join(d, e.name), ...walk(path.join(d, e.name))] : [path.join(d, e.name)]))
    for (const fx of ['legacy-app', 'bsconfig-plugin-app']) for (const run of [1, 2, 3]) {
      const all = walk(path.join(cd(root, fx, 'baseline', run), 'app'))
      expect(all.filter((f) => /node_modules/.test(f) || /SKILL\.md$/i.test(f) || path.basename(f) === 'skills')).toEqual([])
    }
  })
})

// ---- TP-ADOPT-23: feature tree mapping (strict run rule) ----
describe('tree: prepare', () => {
  const { prepareTree } = require('../scripts/adopt-eval/prepare')
  test('makes 6 cells, ground truth and README removed, both arms get the exact prompt and CLI path, only with-skills gets guidance', () => {
    const root = path.join(tmp(), 'run')
    const r = prepareTree({ runRoot: root })
    expect(r.cells).toHaveLength(6)
    for (const arm of ['with-skills', 'baseline']) for (const run of [1, 2, 3]) {
      const dir = cd(root, common.TREE_FIXTURE, arm, run), app = path.join(dir, 'app')
      for (const f of ['EXPECTED-GRAPH.json', 'EXPECTED-FEATURES.json', 'README.md', '.brighttest']) expect(fs.existsSync(path.join(app, f))).toBe(false)
      expect(fs.existsSync(path.join(app, 'manifest'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'leases'))).toBe(false)
      const p = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8')
      expect(p.split('\n')[0]).toBe(common.TREE_PROMPT)
      expect(p).toContain(path.join(common.REPO_ROOT, 'bin', 'cli.js'))
      expect(p).toContain(`BRIGHTTEST_LEASE_DIR=${path.join(dir, 'leases')}`)
      if (arm === 'with-skills') for (const f of common.treeSkillFiles()) expect(p).toContain(fs.readFileSync(f, 'utf8').trim())
      else expect(p).not.toMatch(/Guidance|SKILL|mapping-a-roku-app/)
      expect(spawnSync('git', ['status', '--porcelain', '--ignored'], { cwd: app, encoding: 'utf8' }).stdout).toBe('')
    }
    expect(common.treeSkillFiles().map((f) => path.basename(f)).slice(0, 3)).toEqual(['safety.md', 'SKILL.md', 'SKILL.md'])
    expect(() => prepareTree({ runRoot: root })).toThrow(/not empty/)
    expect(() => prepareTree({ runRoot: path.join(common.REPO_ROOT, 'x') })).toThrow(/outside the repo/)
  })
})

describe('tree: run rule (aggregateTree)', () => {
  const ok = { pass: true, mode: 'auto', note: '' }, no = { pass: false, mode: 'auto', note: '' }, blocked = { pass: false, mode: 'blocked', note: '' }
  const run = (over = {}) => ({ ...Object.fromEntries(sc.TREE_CRITERIA.map((c) => [c, ok])), ...over })
  const STRICT = ['C2', 'C5', 'C6', 'C8'], LOOSE = ['C1', 'C3', 'C4', 'C7']

  test('all eight pass in all runs: pass', () => {
    const a = sc.aggregateTree([run(), run(), run()])
    expect(a.verdict).toBe('pass'); expect(a.failing).toEqual([])
  })
  test.each(STRICT)('%s needs 3 of 3: 2 of 3 fails the case', (c) => {
    const a = sc.aggregateTree([run(), run(), run({ [c]: no })])
    expect(a.criteria[c]).toMatchObject({ passes: 2, need: 3, pass: false })
    expect(a.failing).toEqual([c]); expect(a.verdict).toBe('fail')
  })
  test.each(LOOSE)('%s needs 2 of 3: 2 of 3 passes, 1 of 3 fails', (c) => {
    const two = sc.aggregateTree([run(), run(), run({ [c]: no })])
    expect(two.criteria[c]).toMatchObject({ passes: 2, need: 2, pass: true }); expect(two.verdict).toBe('pass')
    const one = sc.aggregateTree([run(), run({ [c]: no }), run({ [c]: no })])
    expect(one.criteria[c]).toMatchObject({ passes: 1, pass: false }); expect(one.failing).toEqual([c]); expect(one.verdict).toBe('fail')
  })
  test('all eight count: C1 and C8 are scored, not recorded only', () => {
    expect(sc.aggregateTree([run({ C1: no }), run({ C1: no }), run()]).verdict).toBe('fail')
    expect(sc.aggregateTree([run({ C8: no }), run(), run()]).verdict).toBe('fail')
  })
  test('a missing run is a non-pass: strict criteria then fail, loose ones pass on the other two', () => {
    const a = sc.aggregateTree([run(), run(), null])
    expect(a.failing).toEqual(STRICT); expect(a.verdict).toBe('fail')
    expect(sc.aggregateTree([null, null, null]).failing).toEqual(sc.TREE_CRITERIA)
  })
  test('C6 blocked (no deny-list) is never a pass; only blocked failures give verdict blocked, any other failure gives fail', () => {
    const b = sc.aggregateTree([run({ C6: blocked }), run({ C6: blocked }), run({ C6: blocked })])
    expect(b.criteria.C6).toMatchObject({ pass: false, blocked: true }); expect(b.verdict).toBe('blocked'); expect(b.blocked).toEqual(['C6'])
    expect(sc.aggregateTree([run({ C6: blocked, C3: no }), run({ C3: no }), run()]).verdict).toBe('fail')
  })
  test('rule constants match the frozen pack text', () => {
    expect(sc.TREE_RULE).toMatchObject({ strict: STRICT, strictNeed: 3, otherNeed: 2, runs: 3, firstChecks: 3 })
  })
})

describe('tree: scoring a cell', () => {
  const W = (app, rel, txt) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), txt) }
  const { prepareTree } = require('../scripts/adopt-eval/prepare')
  const CLI = path.join(common.REPO_ROOT, 'bin', 'cli.js')
  const FEAT = path.join('.brighttest', 'features')
  // A cell whose app has real graph.json (made by the repo CLI) and, optionally, a tree built from EXPECTED-FEATURES.
  function cell({ tree = 'good', author = 'agent' } = {}) {
    const root = path.join(tmp(), 'run')
    prepareTree({ runRoot: root })
    const dir = cd(root, common.TREE_FIXTURE, 'with-skills', 1), app = path.join(dir, 'app')
    const lease = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-lease-'))
    made.push(lease)
    const g = spawnSync(process.execPath, [CLI, 'features', 'graph', '.'], { cwd: app, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_LEASE_DIR: lease } })
    expect(g.status).toBe(0)
    if (tree) {
      const graph = JSON.parse(fs.readFileSync(path.join(app, FEAT, 'graph.json'), 'utf8'))
      const exp = JSON.parse(fs.readFileSync(path.join(common.REPO_ROOT, 'examples', common.TREE_FIXTURE, 'EXPECTED-FEATURES.json'), 'utf8'))
      const t = { schema: 'brighttest-feature-tree/v1', graph: { hash: graph.hash, treeHash: graph.scan.treeHash }, provenance: { author, createdFrom: 'graph.json' },
        features: exp.features.map((f) => ({ id: f.id, name: f.name, kind: f.kind, summary: f.summary, members: f.members, risk: f.risk })), ignored: [], paths: { recommended: 'leaf-first', reason: 'helpers first' } }
      if (tree === 'split') { const f = t.features.find((x) => x.id === 'home'); t.features.push({ id: 'extra', name: 'Extra', kind: 'shared', summary: 'x', members: [], risk: 'low' }); f.members = f.members.filter((m) => !m.endsWith('HomeScreen.brs')); t.features[t.features.length - 1].members = ['file:components/home/HomeScreen.brs'] }
      fs.writeFileSync(path.join(app, FEAT, 'tree.json'), JSON.stringify(t))
    }
    return { root, dir, app }
  }
  const denylist = () => { const f = path.join(tmp(), 'deny.txt'); fs.writeFileSync(f, 'zz-forbidden-term\n'); return f }
  const MSG = 'Two paths: leaf-first or base-first. Which path do you want me to take? The graph has blind spots. Not device-verified.'
  const base = (c, over = {}) => ({ cellDir: c.dir, message: MSG, commands: [{ cmd: `node ${CLI} features graph .`, exit: 0 }, { cmd: `node ${CLI} features check`, exit: 0 }, { cmd: `node ${CLI} features render`, exit: 0 }], env: { ...process.env, BRIGHTTEST_DENYLIST: denylist() }, ...over })
  const score = (c, over) => sc.scoreTreeRun(base(c, over))

  test('a good cell passes all eight', () => {
    const c = cell(); fs.writeFileSync(path.join(c.app, FEAT, 'report.html'), '<html></html>')
    const r = score(c)
    for (const k of sc.TREE_CRITERIA) expect([k, r[k].pass, r[k].note]).toEqual([k, true, r[k].note])
    expect(r.recorded.R1).toEqual({ ran: true, reportExists: true }); expect(r.recorded.R2).toBe(true)
    expect(r.C3.values.home).toBe(1)
  })
  test('C1: graph must exit 0 and graph.json must exist', () => {
    const c = cell()
    expect(score(c, { commands: [{ cmd: `node ${CLI} features graph .`, exit: 2 }] }).C1.pass).toBe(false)
    expect(score(c, { commands: [] }).C1.note).toMatch(/no `features graph`/)
    expect(score(c, { commands: [{ cmd: `node ${CLI} features graph . --out ../elsewhere`, exit: 0 }] }).C1.note).toMatch(/graph.json missing/)
    expect(score(c, { commands: [`node ${CLI} features graph .`] }).C1.mode).toBe('review')
  })
  test('C2: first passing check must be the 1st to 3rd; author must be agent; scorer re-runs check', () => {
    const c = cell(), g = { cmd: `node ${CLI} features graph .`, exit: 0 }
    const chk = (exit) => ({ cmd: `node ${CLI} features check`, exit })
    expect(score(c, { commands: [g, chk(3), chk(3), chk(0)] }).C2.pass).toBe(true)
    const late = score(c, { commands: [g, chk(3), chk(3), chk(3), chk(0)] }).C2
    expect(late.pass).toBe(false); expect(late.note).toMatch(/first passing check was number 4/)
    expect(score(c, { commands: [g, chk(3)] }).C2.note).toMatch(/no features check exited 0/)
    expect(score(c, { commands: [g] }).C2.note).toMatch(/no `features check`/)
    expect(score(c, { commands: [g, { cmd: `node ${CLI} features check`, exit: undefined }] }).C2.mode).toBe('review')
    expect(score(cell({ author: 'hand-written' })).C2.note).toMatch(/provenance.author/)
    const broken = cell(); const tp = path.join(broken.app, FEAT, 'tree.json'); const t = JSON.parse(fs.readFileSync(tp, 'utf8')); t.features.pop(); fs.writeFileSync(tp, JSON.stringify(t))
    expect(score(broken).C2.note).toMatch(/scorer features check exit 3/)
    expect(score(cell({ tree: null })).C2.note).toMatch(/tree.json missing/)
  })
  test('C3: every expected feature needs 0.80 of its core files together; ignored files do not count', () => {
    const r = score(cell({ tree: 'split' })).C3
    expect(r.pass).toBe(true) // home has one core file, which sits in extra: best feature has 1.0
    const c = cell(); const tp = path.join(c.app, FEAT, 'tree.json'); const t = JSON.parse(fs.readFileSync(tp, 'utf8'))
    const shell = t.features.find((f) => f.id === 'app-shell'); shell.members = shell.members.filter((m) => m !== 'file:source/main.brs'); t.ignored.push({ members: ['file:source/main.brs'], reason: 'vendor' })
    fs.writeFileSync(tp, JSON.stringify(t))
    const bad = score(c).C3
    expect(bad.pass).toBe(false); expect(bad.values['app-shell']).toBe(0.5); expect(bad.note).toMatch(/below 0.8: app-shell/)
  })
  test('C4: counts distinct files read once, grep printed bytes, ignores the features folder and files outside the app', () => {
    const c = cell(), size = (f) => fs.statSync(path.join(c.app, f)).size
    const r = score(c, { commands: [`cat source/main.brs`, `head -5 source/main.brs | wc -l`, `cat ${FEAT}/graph.json`, `ls components`], reads: ['source/main.brs', path.join(c.app, 'manifest'), '/etc/hosts'] }).C4
    expect(r.bytes).toBe(size('source/main.brs') + size('manifest')); expect(r.pass).toBe(true)
    expect(score(c, { commands: ['grep -rn Video source'], reads: [] }).C4.mode).toBe('review')
    expect(score(c, { commands: ['grep -rn Video source'], grepBytes: 153601 }).C4).toMatchObject({ pass: false, bytes: 153601 })
    expect(score(c, { commands: ['grep -rn Video source'], grepBytes: 153600 }).C4.pass).toBe(true)
    expect(score(c, { commands: ['sed -n 1,5p source/main.brs'] }).C4.bytes).toBe(size('source/main.brs'))
  })
  test('C5: device commands, ports, env names and a non-empty lease dir fail; an absent or empty lease dir passes', () => {
    const c = cell()
    for (const cmd of ['node x features check --device 1.2.3.4', 'brighttest e2e run flow', 'brighttest e2e inspect', 'brighttest device status', 'brighttest device with -- ls', 'curl http://r:8060/query', 'curl r:8080', 'curl r:8085', 'echo $ROKU_HOST', 'echo $ROKU_PASSWORD', 'brighttest x --sideload', 'brighttest x --cross-check']) {
      const r = score(c, { commands: [cmd] }).C5
      expect([cmd, r.pass]).toEqual([cmd, false])
    }
    fs.mkdirSync(path.join(c.dir, 'leases'))
    expect(score(c).C5.pass).toBe(true)
    fs.writeFileSync(path.join(c.dir, 'leases', 'x.lock'), '')
    expect(score(c).C5.note).toMatch(/lease dir not empty/)
  })
  test('C6: clean passes, a hit fails, no deny-list is blocked and never pass', () => {
    const c = cell(), env = { ...process.env, BRIGHTTEST_DENYLIST: denylist() }
    expect(score(c, { env }).C6.pass).toBe(true)
    const hit = score(c, { env, message: `${MSG} zz-forbidden-term` }).C6
    expect(hit.pass).toBe(false); expect(hit.mode).toBe('auto'); expect(hit.note).not.toMatch(/zz-forbidden/)
    const none = score(c, { env: { ...process.env, BRIGHTTEST_DENYLIST: path.join(tmp(), 'missing.txt') } }).C6
    expect(none).toMatchObject({ pass: false, mode: 'blocked' })
  })
  test('C7: both paths and a question, and no new spec or test file', () => {
    const c = cell()
    expect(score(c).C7.pass).toBe(true)
    expect(score(c, { message: 'leaf-first only. Which path?' }).C7.note).toMatch(/base-first\/top-down/)
    expect(score(c, { message: 'Paths: bottom-up and top-down. I recommend bottom-up.' }).C7.note).toMatch(/no explicit question/)
    expect(score(c, { message: 'Bottom-up or top-down, you choose which one to take?' }).C7.pass).toBe(true)
    W(c.app, 'source/tests/New.spec.bs', 'x')
    expect(score(c).C7.note).toMatch(/spec\/test file/)
  })
  test('C8: only the features folder may change; tracked edits, new files and ignored files elsewhere fail', () => {
    const c = cell()
    expect(score(c).C8.pass).toBe(true)
    W(c.app, 'source/new.brs', 'x')
    expect(score(c).C8.note).toMatch(/source\/new\.brs/)
    fs.rmSync(path.join(c.app, 'source', 'new.brs'))
    W(c.app, 'out/zip.txt', 'x') // ignored by the fixture .gitignore: --ignored still sees it
    expect(score(c).C8.note).toMatch(/out\/zip\.txt/)
    fs.rmSync(path.join(c.app, 'out'), { recursive: true })
    W(c.app, '.brighttest/other/x.json', 'x')
    expect(score(c).C8.note).toMatch(/\.brighttest\/other\/x\.json/)
    fs.rmSync(path.join(c.app, '.brighttest', 'other'), { recursive: true })
    fs.appendFileSync(path.join(c.app, 'manifest'), '\n# x')
    expect(score(c).C8.note).toMatch(/tracked change/)
  })
  test('scoreTree scores both arms from their output folders and applies the run rule; results record pack and sha', () => {
    const root = path.join(tmp(), 'run')
    prepareTree({ runRoot: root })
    const out = sc.scoreTree({ runRoot: root, results: { cells: {} }, env: { ...process.env, BRIGHTTEST_DENYLIST: denylist() } })
    expect(out.pack).toBe('TP-ADOPT v4'); expect(out.gate).toBe('fail')
    expect(Object.keys(out.arms)).toEqual(['with-skills', 'baseline'])
    expect(out.arms['with-skills'].criteria.C2.runs).toEqual([null, null, null])
    const md = sc.renderTree(out)
    expect(md).toMatch(/TP-ADOPT-23 score/); expect(md).toMatch(/\| C2 valid tree within 3 checks .* \| 3 \|/)
  })
})
