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
    // plugin: C1 fails in all runs, others pass -> 5/6 passes
    expect(sc.aggregate('bsconfig-plugin-app', [runWith(['C1']), runWith(['C1']), runWith(['C1'])]).pass).toBe(true)
    // two criteria fail -> 4/6 fails
    expect(sc.aggregate('bsconfig-plugin-app', [runWith(['C1', 'C4']), runWith(['C1', 'C4']), runWith([])]).pass).toBe(false)
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
