import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeProject, makeEmptyDir, runCli, readFile, exists, cleanupTemp } from './helpers.js'

afterAll(cleanupTemp)

describe('default headless lane (compiles + runs on the simulator, incl. @SGNode)', () => {
  let res
  beforeAll(() => { res = runCli(makeProject()) })

  it('exits 0 when all suites pass', () => {
    expect(res.status).toBe(0)
  })

  it('runs the pure suite and the @SGNode scene suite headless', () => {
    // 3 = 2 math tests + the Widget node test; 2 suites = math + Widget.
    expect(res.output).toContain('3 passed, 0 failed')
    expect(res.output).toContain('2 suites')
  })

  it('exercises the onChange cascade with a seeded global (Widget test passed)', () => {
    // This line only prints as a pass if the node ran headless, read the seeded multiplier,
    // and the onChange observer fired (3 * 2 = 6).
    expect(res.output).toContain('✓ doubles count via seeded multiplier')
  })
})

describe('a failing spec fails the run', () => {
  let res
  beforeAll(() => {
    const dir = makeProject()
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'Broken.spec.bs'), [
      'namespace tests',
      '  @suite("broken")',
      '  class BrokenTests extends rooibos.BaseTestSuite',
      '    @describe("fail")',
      '    @it("fails on purpose")',
      '    function _()',
      '      m.assertEqual(1, 2)',
      '    end function',
      '  end class',
      'end namespace',
      '',
    ].join('\n'))
    res = runCli(dir, ['--no-sgnode'])
  })

  it('exits non-zero', () => {
    expect(res.status).not.toBe(0)
  })

  it('reports the failure with its reason', () => {
    expect(res.output).toContain('Failures')
    expect(res.output).toContain('fails on purpose')
    expect(res.output).toContain('1 failed')
  })
})

describe('a long-named failing test is still counted (scene lane, no false green)', () => {
  let res
  beforeAll(() => {
    const dir = makeProject()
    // A test name long enough that Rooibos truncates its END-It marker's (FAIL). The tally must still
    // come out as a failure — this is the regression guard for the reporter's authoritative summary.
    const longName = 'this is a very long failing test name that definitely exceeds the eighty one character marker width'
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'LongFail.spec.bs'), [
      'namespace tests',
      '  @suite("longfail")',
      '  class LongFailTests extends rooibos.BaseTestSuite',
      '    @describe("long")',
      `    @it("${longName}")`,
      '    function _()',
      '      m.assertEqual(1, 2)',
      '    end function',
      '  end class',
      'end namespace',
      '',
    ].join('\n'))
    // Default lane → scene runner (project has @SGNode specs), which is where the truncation bug lived.
    res = runCli(dir)
  })

  it('exits non-zero and reports the failure in the tally', () => {
    expect(res.status).not.toBe(0)
    expect(res.output).toContain('1 failed')
  })
})

describe('--no-sgnode skips @SGNode suites', () => {
  let res
  beforeAll(() => { res = runCli(makeProject(), ['--no-sgnode']) })

  it('exits 0 and skips the node suite', () => {
    expect(res.status).toBe(0)
    expect(res.output).toContain('@SGNode skipped')
    // Only the 2 pure math tests run when node suites are skipped.
    expect(res.output).toContain('2 passed, 0 failed')
  })
})

describe('--junit writes a report', () => {
  let dir, res
  beforeAll(() => {
    dir = makeProject()
    res = runCli(dir, ['--no-sgnode', '--junit', 'reports/junit.xml'])
  })

  it('exits 0 and writes valid-looking JUnit XML', () => {
    expect(res.status).toBe(0)
    expect(exists(dir, 'reports/junit.xml')).toBe(true)
    const xml = readFile(dir, 'reports/junit.xml')
    expect(xml).toContain('<?xml')
    expect(xml).toContain('<testsuite name="brighttest"')
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="0"')
  })
})

describe('deviceInfo block (COV-02) on the SceneGraph-off lane', () => {
  function project(deviceInfo) {
    const dir = makeProject()
    if (deviceInfo) fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'brighttest.json'), 'utf8')), deviceInfo }))
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'Ident.spec.bs'), [
      'namespace tests',
      '  @suite("ident")',
      '  class IdentTests extends rooibos.BaseTestSuite',
      '    @describe("identity")',
      '    @it("reports the ui resolution")',
      '    function _()',
      '      p = CreateObject("roMessagePort")',
      '      m.assertInvalid(wait(10, p))',
      '      m.assertEqual(CreateObject("roDeviceInfo").GetUIResolution().name, "FHD")',
      '    end function',
      '  end class',
      'end namespace',
      '',
    ].join('\n'))
    return dir
  }
  it('a configured block drives roDeviceInfo (FHD) and message-port waits work', () => {
    const res = runCli(project({ uiResolution: '1080p' }), ['--no-sgnode'])
    expect(res.output).toContain('✓ identity > reports the ui resolution')
    expect(res.status).toBe(0)
  })
  it('a different uiResolution flips the branch (spec fails)', () => {
    const res = runCli(project({ uiResolution: '720p' }), ['--no-sgnode'])
    expect(res.output).toContain('✗ identity > reports the ui resolution')
    expect(res.status).toBe(1)
  })
  it('no block: unchanged engine identity (HD) on the CLI path', () => {
    const res = runCli(project(null), ['--no-sgnode'])
    expect(res.output).toContain('✗ identity > reports the ui resolution')
  })
})

describe('default headless lane mounts the package root (pkg:/ store fixtures, no instrument.net)', () => {
  it('runs the store-fixtures example with instrument.net removed', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'store-fixtures-app')
    const dir = makeEmptyDir()
    fs.cpSync(src, dir, { recursive: true })
    const cfgPath = path.join(dir, 'brighttest.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    delete cfg.instrument
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    const res = runCli(dir)
    expect(res.output).toContain('3 passed, 0 failed')
    expect(res.status).toBe(0)
  })
})

describe('deviceInfo run also mounts the package root and a zero-splash staged manifest', () => {
  it('runs the store-fixtures example with deviceInfo uiResolution 1080p and no instrument', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'store-fixtures-app')
    const dir = makeEmptyDir()
    fs.cpSync(src, dir, { recursive: true })
    const cfgPath = path.join(dir, 'brighttest.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    delete cfg.instrument
    cfg.deviceInfo = { uiResolution: '1080p' }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    const res = runCli(dir)
    expect(res.output).toContain('3 passed, 0 failed')
    expect(res.status).toBe(0)
    const staged = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'manifest') staged.push(p) } }
    walk(path.join(dir, '.brighttest'))
    expect(staged.length).toBeGreaterThan(0)
    expect(fs.readFileSync(staged[0], 'utf8')).toMatch(/^splash_min_time=0$/m)
    expect(fs.readFileSync(path.join(dir, 'manifest'), 'utf8')).not.toContain('splash_min_time')
  })
})

describe('@async cases in an @SGNode suite are never silently dropped', () => {
  const spec = (dir) => path.join(dir, 'source', 'tests', 'Async.spec.bs')

  it('counts all 13 cases when every @async case calls m.done()', () => {
    const dir = makeProject('async-node')
    fs.writeFileSync(spec(dir), fs.readFileSync(spec(dir), 'utf8').replace(/\n    @async\(500\)/, ''))
    const res = runCli(dir)
    expect(res.status).toBe(0)
    expect(res.output).toContain('13 passed, 0 failed')
    for (let i = 1; i <= 4; i++) expect(res.output).toContain(`✓ async done ${i}`)
  })

  it('fails loudly, naming each case that did not run, when an @async case never calls m.done()', () => {
    const dir = makeProject('async-node')
    const res = runCli(dir, ['--junit', 'reports/junit.xml'])
    expect(res.status).not.toBe(0)
    // 5 ran and passed; the timed-out case + the 7 after it are reported failed: 13 counted in all.
    expect(res.output).toContain('5 passed, 8 failed')
    expect(res.output).toContain('Failures (8)')
    for (const n of ['async never done', 'sync 6', 'sync 7', 'sync 8', 'async done 1', 'async done 4']) {
      expect(res.output).toContain(`✗ ${n}`)
    }
    // The case the suite stopped in is the one named "started but never finished"; the others "never ran".
    expect(res.output).toMatch(/✗ async never done\n\s+started but never finished/)
    expect(res.output).toMatch(/✗ sync 6\n\s+never ran: the suite stopped at "async never done"/)
    expect(res.output).not.toMatch(/✗ sync [1-5]\n/)
    // JUnit: every failure has an element, and the counts agree.
    const xml = readFile(dir, 'reports/junit.xml')
    expect(xml).toContain('tests="13" failures="8"')
    expect(xml.match(/<failure>/g)).toHaveLength(8)
    expect(xml).toMatch(/<testcase name="async never done"><failure>started but never finished/)
    expect(xml).toMatch(/<testcase name="async done 4"><failure>never ran/)
  })

  it('still fails when another suite full of @ignore\'d tests hides the missing cases from the totals', () => {
    const dir = makeProject('async-node')
    const ignored = Array.from({ length: 14 }, (_, i) => `    @ignore\n    @it("ign ${i + 1}")\n    function _()\n      m.assertTrue(true)\n    end function\n`).join('\n')
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'Plain.spec.bs'),
      `namespace tests\n  @suite("Plain")\n  class PlainTests extends rooibos.BaseTestSuite\n    @describe("p")\n    @it("p1")\n    function _()\n      m.assertTrue(true)\n    end function\n\n${ignored}\n  end class\nend namespace\n`)
    const res = runCli(dir, ['--junit', 'reports/junit.xml'])
    expect(res.status).not.toBe(0)
    expect(res.output).toMatch(/✗ async never done\n\s+started but never finished/)
    expect(res.output).toContain('✗ async done 4')
    expect(readFile(dir, 'reports/junit.xml')).toMatch(/<testcase name="async never done"><failure>started but never finished/)
  })

  it('does not blame a passing long-named or @params case before the stall', () => {
    const dir = makeProject('async-node')
    const f = spec(dir)
    const long = 'sync 2 has a rather long descriptive name that exceeds the widths rooibos allows'
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(
      '@it("sync 2")\n    function _()',
      `@it("${long}")\n    @params(1, 2)\n    @params(3, 4)\n    function _(a, b)`).replace(
      '@it("sync 3")', `@it("${long} again")\n    function _()\n      m.assertTrue(true)\n    end function\n\n    @it("sync 3")`))
    const res = runCli(dir)
    expect(res.status).not.toBe(0)
    expect(res.output).toMatch(/✗ async never done\n\s+started but never finished/)
    expect(res.output).not.toMatch(/✗ sync 2/)
    expect(res.output).not.toMatch(/✗ \[[13],[24]\]/)
    expect(res.output).not.toMatch(/✗ sync [135]\n/)
  })
})

describe('a crashed scene run fails instead of dropping cases', () => {
  // The real engine cannot be made to crash on demand, so the project gets a stand-in brs-node that replays what
  // the real one prints when a run dies mid-suite: two cases pass, a third starts, then EXIT_BRIGHTSCRIPT_CRASH.
  // No Rooibos summary is ever printed.
  const LOG = [
    '> SUITE: Widget crash>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>',
    '>>>> Describe: cases around a crash>>>>>>>>>>>>>>>>>>>>',
    '>>>>>> It: sync 1>>>>>>>>>>>>>>>>>>>>',
    '<<<< END It: sync 1 (PASS) <<<<<<<<<<<<<<<<<<<<',
    '>>>>>> It: sync 2>>>>>>>>>>>>>>>>>>>>',
    '<<<< END It: sync 2 (PASS) <<<<<<<<<<<<<<<<<<<<',
    '>>>>>> It: crashing case>>>>>>>>>>>>>>>>>>>>',
    "pkg:/components/Widget.brs(4,4-6): 'Dot' Operator attempted with invalid BrightScript Component or interface reference.",
    "------ Finished 'pkg.zip' execution [EXIT_BRIGHTSCRIPT_CRASH] ------",
  ].join('\n')

  function crashProject() {
    const dir = makeProject('crash-node')
    const eng = path.join(dir, 'node_modules', '@ramonlobo', 'brs-node')
    fs.mkdirSync(path.join(eng, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(eng, 'package.json'), JSON.stringify({ name: '@ramonlobo/brs-node', version: '2.7.0', bin: { 'brs-cli': 'bin/cli.js' } }))
    fs.writeFileSync(path.join(eng, 'bin', 'cli.js'), `console.log(${JSON.stringify(LOG)})\n`)
    return dir
  }

  it('exits non-zero, says the run crashed, and lists the open case as failed in JUnit', () => {
    const dir = crashProject()
    const res = runCli(dir, ['--junit', 'reports/junit.xml'])
    expect(res.status).not.toBe(0)
    expect(res.output).toContain('RUN CRASHED (EXIT_BRIGHTSCRIPT_CRASH)')
    expect(res.output).toContain('2 passed, 1 failed')
    expect(res.output).toMatch(/✗ crashing case\n\s+the run crashed/)
    const xml = readFile(dir, 'reports/junit.xml')
    expect(xml).toContain('tests="3" failures="1"')
    expect(xml).toMatch(/<testcase name="crashing case"><failure>the run crashed \(EXIT_BRIGHTSCRIPT_CRASH\)/)
  })
})

describe('instrument.enabled on a scratch copy of the legacy example app', () => {
  const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'legacy-app')
  const scratch = []
  afterAll(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }) })
  function copyLegacy(patch) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-inst-'))
    scratch.push(d)
    fs.cpSync(EXAMPLE, d, { recursive: true, filter: (f) => !/[\\/](\.brighttest|coverage)$/.test(f) })
    const file = path.join(d, 'brighttest.json')
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    patch(cfg)
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
    return d
  }

  it('default lane: specs pass on the scene lane with the state agent baked in', () => {
    const dir = copyLegacy((c) => { c.instrument.enabled = true })
    const res = runCli(dir)
    expect(res.status).toBe(0)
    expect(res.output).toContain('17 passed, 0 failed')
    expect(exists(dir, '.brighttest/headless-scene/build/components/bt/BT_Agent.brs')).toBe(true)
  })

  it('--coverage: specs pass and the LCOV lists no injected tool files', () => {
    const dir = copyLegacy((c) => { c.instrument.enabled = true })
    const res = runCli(dir, ['--coverage'])
    expect(res.status).toBe(0)
    expect(res.output).toContain('17 passed, 0 failed')
    expect(exists(dir, '.brighttest/headless-coverage/build/components/bt/BT_Agent.brs')).toBe(true)
    const lcov = readFile(dir, 'coverage/lcov.info')
    expect(lcov).toContain('SF:')
    expect(lcov).not.toMatch(/SF:.*(source|components)\/bt\//)
  })

  it('a bad block does not fail a run that is not enabled; it fails an enabled one (exit 2)', () => {
    const off = runCli(copyLegacy((c) => { c.instrument.enabled = 'yes' }))
    expect(off.status).toBe(0)
    expect(off.output).toContain('[brighttest] instrument: instrument.enabled must be true or false (got "yes")')
    const stateOnly = runCli(copyLegacy((c) => { c.instrument.state = 'x' }))
    expect(stateOnly.status).toBe(0)
    const bad = copyLegacy((c) => { c.instrument.enabled = true; c.instrument.state = 'x' })
    const res = runCli(bad)
    expect(res.status).toBe(2)
    expect(res.output).toContain('[brighttest] instrument: instrument.state must be true, false or an object')
  })

  it('--no-sgnode with the state agent exits 2 before anything is built', () => {
    const dir = copyLegacy((c) => { c.instrument.enabled = true })
    const res = runCli(dir, ['--no-sgnode'])
    expect(res.status).toBe(2)
    expect(res.output).toContain('--no-sgnode runs no SceneGraph')
    expect(exists(dir, '.brighttest')).toBe(false)
  })
})
