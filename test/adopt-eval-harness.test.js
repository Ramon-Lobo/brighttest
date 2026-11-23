import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { prepare } = require('../scripts/adopt-eval/prepare')
const common = require('../scripts/adopt-eval/common')
const sc = require('../scripts/adopt-eval/score')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-eval-'))

describe('prepare', () => {
  test('makes 12 cells with git-initialised app copies, no ground truth', () => {
    const root = path.join(tmp(), 'run')
    const r = prepare({ runRoot: root })
    expect(r.cells).toHaveLength(12)
    const app = path.join(root, 'legacy-app', 'baseline', 'run1', 'app')
    expect(fs.existsSync(path.join(app, 'manifest'))).toBe(true)
    expect(fs.existsSync(path.join(app, 'EXPECTED-CENSUS.json'))).toBe(false)
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: app, encoding: 'utf8' }).stdout).toBe('')
    expect(fs.existsSync(path.join(root, 'bsconfig-plugin-app', 'with-skills', 'run3', 'prompt.md'))).toBe(true)
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

// Excerpts below are generic phrasings taken from the real ADOPT-21a T1 results.json (legacy-app and bsconfig-plugin-app fixtures).
const gitApp = () => {
  const app = tmp()
  spawnSync('git', ['init', '-q'], { cwd: app })
  fs.writeFileSync(path.join(app, 'a'), '1')
  const g = ['-c', 'user.name=a', '-c', 'user.email=a@b.c']
  spawnSync('git', [...g, 'add', '-A'], { cwd: app })
  spawnSync('git', [...g, 'commit', '-q', '-m', 'x'], { cwd: app })
  return app
}
const RUN_RESULTS = path.join(os.homedir(), 'brighttest-pack-runs', 'ADOPT-21a-T1-results', 'results.json')

describe('score mechanics (ADOPT-12 harness fixes)', () => {
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
  test('contamination detects assess runs and README reads', () => {
    expect(sc.contamination({ message: 'I ran node /x/bin/cli.js assess .' })).toEqual(['ran assess'])
    expect(sc.contamination({ message: 'clean', reads: ['/app/README.md'] })).toEqual(['read README'])
    expect(sc.contamination({ message: 'Counted files by hand.', commands: ['find . -name "*.brs"'] })).toEqual([])
  })
  test('score() excludes contaminated baseline cells and lists them', () => {
    const root = path.join(tmp(), 'run')
    prepare({ runRoot: root })
    const cells = { 'legacy-app/baseline/run1': { finalMessage: 'I ran brighttest assess on it' }, 'legacy-app/baseline/run2': { finalMessage: 'plain read, nothing special' } }
    const out = sc.score({ runRoot: root, results: { cells } })
    expect(out.contaminated).toEqual([{ cell: 'legacy-app/baseline/run1', why: ['ran assess'] }])
    expect(out.fixtures['legacy-app/baseline'].criteria.C1.runs[0]).toBeNull()
    expect(sc.render(out)).toContain('Contaminated baseline cells')
  })
  test.skipIf(!fs.existsSync(RUN_RESULTS))('real ADOPT-21a results.json: legacy with-skills C2 and C5-edit-half now read as the architect hand-read says', () => {
    const cells = JSON.parse(fs.readFileSync(RUN_RESULTS, 'utf8')).cells
    const app = gitApp()
    for (const n of [1, 2, 3]) {
      const m = cells[`legacy-app/with-skills/run${n}`].finalMessage
      expect(sc.scoreRun({ fixture: 'legacy-app', message: m, appDir: app }).C2.pass).toBe(true)
      expect(sc.questionsIn(m).some((q) => /\bedit(?:s|ed|ing)?\b/i.test(q))).toBe(true)
    }
    const p3 = cells['bsconfig-plugin-app/with-skills/run3'].finalMessage
    expect(sc.scoreRun({ fixture: 'bsconfig-plugin-app', message: p3, appDir: app }).C2.pass).toBe(true)
  })
})

describe('prepare and prompt (ADOPT-12 harness fixes)', () => {
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
      expect(fs.existsSync(path.join(root, fx, 'baseline', 'run1', 'app', 'README.md'))).toBe(false)
      expect(fs.existsSync(path.join(root, fx, 'with-skills', 'run1', 'app', 'README.md'))).toBe(true)
    }
  })
})
