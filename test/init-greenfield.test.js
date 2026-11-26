import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Program } = require('brighterscript')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'cli.js')

function init(cwd, extra = []) {
  return spawnSync(process.execPath, [cli, 'init', '--greenfield', ...extra], { cwd, encoding: 'utf8', timeout: 60000 })
}
// spawnSync returns once the CLI process exits, but a straggler it started (engine child, cache writer) can still
// be writing into the tree for a moment, which makes a plain rmSync fail with ENOTEMPTY. Retry for ~10 s and log
// (never throw) if the dir still cannot be removed: cleanup must not fail the test.
function rmTemp(d) {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) }
  catch (e) { console.warn(`init-greenfield cleanup failed for ${d}: ${e.message}`) }
}
function scratch(manifest) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-gf-'))
  if (manifest !== null) fs.writeFileSync(path.join(d, 'manifest'), manifest)
  return d
}

describe('init --greenfield', () => {
  it('copies version-headed templates and adds BT_AGENT=false', () => {
    const d = scratch('title=X\nbs_const=FOO=true\n')
    try {
      const r = init(d)
      expect(r.status).toBe(0)
      for (const [f, re] of [['BTStore.brs', /^' brighttest-template: BTStore v\d+/], ['BTHttp.brs', /^' brighttest-template: BTHttp v\d+/]]) {
        const body = fs.readFileSync(path.join(d, 'source', 'brighttest', f), 'utf8')
        expect(body.split('\n')[0]).toMatch(re)
      }
      const m = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      expect(m).toContain('bs_const=FOO=true;BT_AGENT=false')
    } finally { rmTemp(d) }
  })

  it('adds a bs_const line when none exists', () => {
    const d = scratch('title=X\n')
    try {
      init(d)
      const m = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      expect(m.match(/^bs_const=/gm)).toHaveLength(1)
      expect(m).toContain('bs_const=BT_AGENT=false')
    } finally { rmTemp(d) }
  })

  it('is idempotent on re-run', () => {
    const d = scratch('title=X\nbs_const=FOO=true\n')
    try {
      init(d)
      const before = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      const tpl = path.join(d, 'source', 'brighttest', 'BTStore.brs')
      fs.appendFileSync(tpl, "' local edit\n")
      const r = init(d)
      expect(r.status).toBe(0)
      expect(fs.readFileSync(path.join(d, 'manifest'), 'utf8')).toBe(before)
      expect(fs.readFileSync(tpl, 'utf8')).toContain("' local edit")
      expect((before.match(/BT_AGENT/g) || [])).toHaveLength(1)
    } finally { rmTemp(d) }
  })

  it('does not flip an existing BT_AGENT const', () => {
    const d = scratch('title=X\nbs_const=BT_AGENT=true\n')
    try {
      init(d)
      expect(fs.readFileSync(path.join(d, 'manifest'), 'utf8')).toContain('bs_const=BT_AGENT=true')
    } finally { rmTemp(d) }
  })

  it('without --greenfield nothing is copied', () => {
    const d = scratch('title=X\n')
    try {
      spawnSync(process.execPath, [cli, 'init'], { cwd: d, encoding: 'utf8', timeout: 60000 })
      expect(fs.existsSync(path.join(d, 'source', 'brighttest'))).toBe(false)
      expect(fs.readFileSync(path.join(d, 'manifest'), 'utf8')).not.toContain('BT_AGENT')
    } finally { rmTemp(d) }
  })
})

describe('init --greenfield (hardening)', () => {
  it('matches bs_const case-insensitively and never flips it', () => {
    const d = scratch('title=X\nbs_const=bt_agent=true\n')
    try {
      init(d)
      const m = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      expect(m).toContain('bs_const=bt_agent=true')
      expect(m.match(/bt_agent/gi)).toHaveLength(1)
    } finally { rmTemp(d) }
  })

  it('preserves CRLF line endings', () => {
    const d = scratch('title=X\r\nbs_const=FOO=true\r\nmajor_version=1\r\n')
    try {
      init(d)
      const m = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      expect(m).toBe('title=X\r\nbs_const=FOO=true;BT_AGENT=false\r\nmajor_version=1\r\n')
    } finally { rmTemp(d) }
  })

  it('--force refreshes only the templates, not brighttest.json or Example.spec.bs', () => {
    const d = scratch('title=X\n')
    try {
      init(d)
      fs.writeFileSync(path.join(d, 'brighttest.json'), '{"mine":true}')
      fs.writeFileSync(path.join(d, 'source', 'tests', 'Example.spec.bs'), "' mine\n")
      const tpl = path.join(d, 'source', 'brighttest', 'BTStore.brs')
      fs.writeFileSync(tpl, 'stale')
      const r = init(d, ['--force'])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(path.join(d, 'brighttest.json'), 'utf8')).toBe('{"mine":true}')
      expect(fs.readFileSync(path.join(d, 'source', 'tests', 'Example.spec.bs'), 'utf8')).toBe("' mine\n")
      expect(fs.readFileSync(tpl, 'utf8')).toMatch(/brighttest-template: BTStore/)
    } finally { rmTemp(d) }
  })

  it('rejects --greenfield with --brownfield', () => {
    const d = scratch('title=X\n')
    try {
      const r = spawnSync(process.execPath, [cli, 'init', '--greenfield', '--brownfield'], { cwd: d, encoding: 'utf8', timeout: 60000 })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/cannot be combined/)
      expect(fs.existsSync(path.join(d, 'source', 'brighttest'))).toBe(false)
    } finally { rmTemp(d) }
  })

  it('prints the script tag wiring in the Next output', () => {
    const d = scratch('title=X\n')
    try {
      expect(init(d).stdout).toContain('uri="pkg:/source/brighttest/BTStore.brs"')
    } finally { rmTemp(d) }
  })
})

function compileErrors(files) {
  const program = new Program({ rootDir: os.tmpdir(), diagnosticFilters: [] })
  for (const [name, text] of Object.entries(files)) program.setFile(name, text)
  program.validate()
  return program.getDiagnostics().filter((x) => x.severity === 1).map((x) => `${x.file && x.file.srcPath}:${x.range && x.range.start.line + 1} ${x.message}`)
}

describe('templates compile with brighterscript', () => {
  const tdir = path.join(root, 'lib', 'instrument', 'greenfield')
  for (const f of ['BTStore.brs', 'BTHttp.brs']) {
    it(`${f} has zero errors`, () => {
      expect(compileErrors({ [`source/brighttest/${f}`]: fs.readFileSync(path.join(tdir, f), 'utf8') })).toEqual([])
    })
  }

  it('an init-ed copy of examples/greenfield-app has no template errors', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-gf-app-'))
    try {
      fs.cpSync(path.join(root, 'examples', 'greenfield-app'), d, { recursive: true })
      expect(init(d).status).toBe(0)
      const files = {}
      for (const f of ['BTStore.brs', 'BTHttp.brs']) files[`source/brighttest/${f}`] = fs.readFileSync(path.join(d, 'source', 'brighttest', f), 'utf8')
      expect(compileErrors(files)).toEqual([])
    } finally { rmTemp(d) }
  })
})

describe('BTStore pure mode (brs-cli)', () => {
  it('reduces actions without SceneGraph', () => {
    const brsCli = path.join(root, 'node_modules', '@ramonlobo', 'brs-node', 'bin', 'brs.cli.js')
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-gf-pure-'))
    try {
      const store = fs.readFileSync(path.join(root, 'lib', 'instrument', 'greenfield', 'BTStore.brs'), 'utf8')
      const main = `
function User_reduce(state as object, action as object) as object
    if action.type = "user/upgraded" then return { tier: action.payload.tier }
    return state
end function
sub main()
    store = BTStore_create({ user: User_reduce }, { user: { tier: "free" } })
    print "A=" + store.state.user.tier
    store.dispatch({ type: "user/upgraded", payload: { tier: "premium" } })
    print "B=" + store.state.user.tier
    print "N=" + store.actions.Count().ToStr()
end sub
`
      const file = path.join(d, 'pure.brs')
      fs.writeFileSync(file, store + main)
      const r = spawnSync(process.execPath, [brsCli, file], { encoding: 'utf8', timeout: 30000 })
      expect(r.stdout + r.stderr).toMatch(/A=free[\s\S]*B=premium[\s\S]*N=1/)
    } finally { rmTemp(d) }
  })
})

describe('init with a plain source/main.brs', () => {
  it('leaves main.brs in sourceGlobs and the scene-lane headless run still finishes (runtime exclusion)', () => {
    const d = scratch(null)
    try {
      fs.cpSync(path.join(root, 'examples', 'greenfield-skeleton'), d, { recursive: true })
      expect(init(d).status).toBe(0)
      // the hang only happens on the scene lane, which needs an @SGNode spec
      fs.writeFileSync(path.join(d, 'source', 'tests', 'Probe.spec.bs'), `namespace tests
  @suite("probe")
  @SGNode("HomeScene")
  class ProbeTests extends rooibos.BaseTestSuite
    @describe("node")
    @it("loads")
    function _()
      m.assertTrue(true)
    end function
  end class
end namespace
`)
      // the CLI's own watchdog (60 s) kills the engine child; the spawnSync cap is only a backstop
      const r = spawnSync(process.execPath, [cli, '--timeout', '60'], { cwd: d, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' })
      expect(r.error, 'headless run hung').toBeUndefined()
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/\b[23] passed, 0 failed/)
      const cfg = JSON.parse(fs.readFileSync(path.join(d, 'brighttest.json'), 'utf8'))
      expect(cfg.sourceGlobs).not.toContain('!source/main.brs')
      expect(r.stdout).toMatch(/excluded source\/main\.brs from the test build/)
    } finally { rmTemp(d) }
  }, 150000)

  it('does not write a main.brs exclusion when there is no source/main.brs', () => {
    const d = scratch('title=X\n')
    try {
      init(d)
      const cfg = JSON.parse(fs.readFileSync(path.join(d, 'brighttest.json'), 'utf8'))
      expect(cfg.sourceGlobs).not.toContain('!source/main.brs')
    } finally { rmTemp(d) }
  })
})
