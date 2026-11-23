import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const assess = require('../lib/assess')
const ROOT = path.resolve(__dirname, '..')
const FIX = path.join(ROOT, 'test', 'fixtures', 'assess')
// examples/legacy-app is the brownfield fixture (read-only); examples/greenfield-app is not used here (ADOPT-20 owns
// it), the greenfield cases use test/fixtures/assess/skeleton.
const LEGACY = path.join(ROOT, 'examples', 'legacy-app')
const SKELETON = path.join(FIX, 'skeleton')
const PLUGIN = path.join(FIX, 'plugin-app')
const PLAIN = path.join(FIX, 'plain-dir')

async function run(args) {
  let out = '', err = ''
  const code = await assess.run(args, { stdout: (s) => { out += s }, stderr: (s) => { err += s } })
  return { code, out, err }
}
const json = async (dir, extra = []) => JSON.parse((await run([dir, '--json', ...extra])).out)

function hashTree(dir) {
  const h = crypto.createHash('sha256')
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { h.update(`d:${path.relative(dir, p)}\n`); walk(p) } else h.update(`f:${path.relative(dir, p)}:${fs.readFileSync(p).toString('hex')}\n`)
    }
  }
  walk(dir)
  return h.digest('hex')
}

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-assess-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe('assess: no side effects', () => {
  test('no network, dns, dgram or subprocess call, and the tree is unchanged without --out', async () => {
    const boom = (name) => () => { throw new Error(`forbidden call: ${name}`) }
    const spies = []
    for (const [modName, fns] of Object.entries({
      child_process: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
      net: ['connect', 'createConnection', 'createServer'], http: ['request', 'get'], https: ['request', 'get'],
      dgram: ['createSocket'], dns: ['lookup', 'resolve', 'resolve4'],
    })) {
      const m = require(`node:${modName}`)
      for (const f of fns) spies.push(vi.spyOn(m, f).mockImplementation(boom(`${modName}.${f}`)))
    }
    spies.push(vi.spyOn(globalThis, 'fetch').mockImplementation(boom('fetch')))
    const before = hashTree(LEGACY)
    const r = await run([LEGACY, '--json'])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(spies.filter((s) => s.mock.calls.length)).toEqual([])
    expect(hashTree(LEGACY)).toBe(before)
    const a = JSON.parse(r.out).scan.treeHash
    expect((await json(LEGACY)).scan.treeHash).toBe(a)
  })

  test('never opens .env, key files, certs/ or the device cache, and prints no secret value', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, '.env'), 'ROKU_PASSWORD=probe-0001\n')
    fs.writeFileSync(path.join(tmp, 'key.pem'), 'probe-pem-0002')
    fs.mkdirSync(path.join(tmp, 'certs'))
    fs.writeFileSync(path.join(tmp, 'certs', 'dev.p12'), 'probe-p12-0003')
    const cache = path.join(tmp, 'devices-cache.json')
    fs.writeFileSync(cache, '{"probe-0004":"x"}')
    const old = process.env.BRIGHTTEST_CACHE
    process.env.BRIGHTTEST_CACHE = cache
    const opened = []
    const real = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...a) => { opened.push(String(p)); return real(p, ...a) })
    vi.spyOn(fs, 'openSync')
    try {
      const r = await run([tmp, '--json'])
      expect(r.code).toBe(0)
      expect(r.out + r.err).not.toMatch(/probe-000[1-4]/)
      expect(opened.filter((p) => /\.env|\.pem|\.p12|devices-cache|[\\/]certs[\\/]/.test(p))).toEqual([])
      const rep = JSON.parse(r.out)
      expect(rep.devices.deviceCacheExists).toBe(true)
      expect(Object.keys(rep.devices).sort()).toEqual(['deviceCacheExists', 'envHostSet'])
      expect(rep.scan.skippedSensitive).toBe(2)
    } finally { if (old === undefined) delete process.env.BRIGHTTEST_CACHE; else process.env.BRIGHTTEST_CACHE = old }
  })

  test('over-cap files are counted and reported as truncated, not read', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'source', 'big.brs'), Buffer.alloc(assess.MAX_BYTES + 1, 'a'))
    const rep = await json(tmp)
    expect(rep.scan.overCap).toBe(1)
    expect(rep.project.files.truncated).toBe(true)
    expect(rep.project.files.brs).toBe(1)
  })

  test('skipped directories are not scanned', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    for (const d of ['node_modules/x', '.git', 'out', 'dist', 'build', '.brighttest', 'coverage', 'reports']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true })
      fs.writeFileSync(path.join(tmp, d, 'a.brs'), "sub A()\nend sub\n")
    }
    expect((await json(tmp)).project.files.brs).toBe(1)
  })
})

describe('assess: exit codes', () => {
  test('0 for a normal run and for a non-Roku directory', async () => {
    expect((await run([LEGACY])).code).toBe(0)
    expect((await run([PLAIN])).code).toBe(0)
  })
  test('2 for a missing directory, bad option, bad config and --help is 0', async () => {
    expect((await run([path.join(tmp, 'nope')])).code).toBe(2)
    expect((await run([LEGACY, '--bogus'])).code).toBe(2)
    expect((await run([LEGACY, '--out'])).code).toBe(2)
    expect((await run([LEGACY, '-c', path.join(tmp, 'missing.json')])).code).toBe(2)
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{ nope')
    expect((await run([LEGACY, '-c', path.join(tmp, 'bad.json')])).code).toBe(2)
    const h = await run(['--help'])
    expect(h.code).toBe(0)
    expect(h.out).toMatch(/brighttest assess/)
  })
  test('the CLI dispatches assess and returns the same codes', async () => {
    const cp = require('node:child_process')
    const cli = path.join(ROOT, 'bin', 'cli.js')
    const ok = cp.spawnSync(process.execPath, [cli, 'assess', SKELETON, '--json'], { encoding: 'utf8' })
    expect(ok.status).toBe(0)
    expect(JSON.parse(ok.stdout).schema).toBe('brighttest-assess/v1')
    expect(cp.spawnSync(process.execPath, [cli, 'assess', path.join(tmp, 'nope')], { encoding: 'utf8' }).status).toBe(2)
  })
})

describe('assess: --json shape (brighttest-assess/v1)', () => {
  const keys = (o) => Object.keys(o).sort()
  test('required keys per section', async () => {
    const r = await json(LEGACY)
    expect(r.schema).toBe('brighttest-assess/v1')
    for (const k of ['cliVersion', 'root', 'host', 'project', 'brighttest', 'census', 'secrets', 'risky', 'ci', 'gitignore', 'devices', 'recommendation']) expect(r).toHaveProperty(k)
    expect(keys(r.host)).toEqual(['node', 'nodeOk', 'nodeRequired', 'platform'])
    expect(keys(r.project)).toEqual(['bsconfig', 'dirs', 'files', 'isRokuApp', 'language', 'manifest', 'manifestKeys', 'packageManagerDeps', 'rooibos', 'ropm'])
    expect(keys(r.project.bsconfig)).toEqual(['bsConstOverride', 'file', 'files', 'mapping', 'plugins', 'present', 'rootDir', 'unsupported'])
    expect(keys(r.project.rooibos)).toEqual(['brsAnnotated', 'present', 'specFiles', 'specsOutsideSource'])
    expect(keys(r.project.files)).toEqual(['brs', 'bs', 'bytes', 'truncated', 'xml'])
    expect(keys(r.brighttest)).toEqual(['config', 'engines', 'installed'])
    expect(keys(r.brighttest.config)).toEqual(['deprecatedKeys', 'file', 'keys', 'present'])
    expect(r.brighttest.engines).toHaveProperty('warnings')
    expect(keys(r.census)).toEqual(['components', 'couldNotInstrument', 'error', 'globalFields', 'inlineCdataScenes', 'notCovered', 'registrySections', 'scenes', 'setUrlCovered', 'setUrlSites', 'tasks'])
    expect(keys(r.ci)).toEqual(['nodeOk', 'nodeVersions', 'runsBrighttest', 'selfHosted', 'systems'])
    expect(keys(r.gitignore)).toEqual(['brighttest', 'coverage', 'env', 'instrumentedZip', 'present'])
    expect(keys(r.recommendation)).toEqual(['blockers', 'editPermission', 'nextSteps', 'path', 'unknowns'])
    expect(r.secrets).toEqual([])
    expect(r.scans.secrets).toMatch(/not-run/)
    expect(JSON.stringify(r)).not.toContain(JSON.stringify(os.homedir()).slice(1, -1))
    expect(JSON.stringify(r)).not.toContain(os.homedir())
  })
  test('human output lists the sections in order', async () => {
    const out = (await run([LEGACY])).out
    const order = ['host:', 'project:', 'bsconfig:', 'manifest:', 'engines:', 'census:', 'ci:', 'gitignore:', 'devices:', 'recommend:']
    const idx = order.map((s) => out.indexOf(s))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })
})

describe('TP-ADOPT-04 (brownfield fixture)', () => {
  test('census block equals EXPECTED-CENSUS and the recommendation is brownfield', async () => {
    const exp = JSON.parse(fs.readFileSync(path.join(LEGACY, 'EXPECTED-CENSUS.json'), 'utf8'))
    const r = await json(LEGACY)
    expect(r.census.components).toBe(exp.components)
    expect(r.census.tasks).toBe(exp.tasks)
    expect(r.census.scenes).toBe(6)
    expect(r.census.setUrlSites).toBe(4)
    expect(r.census.couldNotInstrument).toBe(1)
    expect(r.census.registrySections).toEqual(['legacy_prefs', 'legacy_session'])
    expect(r.census.error).toBeNull()
    expect(r.project.files.xml).toBe(exp.xmlFiles)
    expect(r.recommendation.path).toBe('brownfield')
    expect(r.recommendation.editPermission).toBe('unknown')
    expect(r.brighttest.config.keys).toContain('instrument')
  })
  test('--out writes assess.json, assess.md, census.json, census.md and nothing else', async () => {
    const out = path.join(tmp, 'out')
    const r = await run([LEGACY, '--out', out])
    expect(r.code).toBe(0)
    expect(fs.readdirSync(out).sort()).toEqual(['assess.json', 'assess.md', 'census.json', 'census.md'])
    expect(JSON.parse(fs.readFileSync(path.join(out, 'assess.json'), 'utf8')).schema).toBe('brighttest-assess/v1')
  })
  test('engines resolve from the project node_modules only', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    const d = path.join(tmp, 'node_modules', '@ramonlobo', 'brs-node')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@ramonlobo/brs-node', version: '2.2.0', brighttest: { patches: {} } }))
    const r = await json(tmp)
    expect(r.brighttest.engines.brsNode).toEqual({ name: '@ramonlobo/brs-node', version: '2.2.0', patched: true })
    expect(r.brighttest.engines.rooibos).toBeNull()
    expect(r.brighttest.engines.warnings.join(' ')).toMatch(/2\.7\.0/)
  })
})

describe('TP-ADOPT-06 (greenfield, plugin app, non-Roku dir, bad input)', () => {
  test('skeleton is greenfield', async () => {
    const r = await json(SKELETON)
    expect(r.recommendation.path).toBe('greenfield')
    expect(r.project.isRokuApp).toBe(true)
  })
  test('plugin app flags plugins as unsupported and names the plugin in a blocker', async () => {
    const r = await json(PLUGIN)
    expect(r.project.bsconfig.unsupported).toContain('plugins')
    expect(r.recommendation.blockers.join(' ')).toMatch(/my-plugin/)
    expect(r.ci.systems).toEqual(['github-actions'])
    expect(r.ci.nodeVersions).toEqual(['20'])
    expect(r.ci.nodeOk).toBe(false)
    expect(r.gitignore.env).toBe(true)
  })
  test('empty and non-Roku directories are not-a-roku-app with exit 0', async () => {
    fs.mkdirSync(path.join(tmp, 'empty'))
    for (const d of [path.join(tmp, 'empty'), PLAIN]) {
      const r = await run([d, '--json'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out).recommendation.path).toBe('not-a-roku-app')
    }
  })
  test('missing path is exit 2', async () => { expect((await run([path.join(tmp, 'missing')])).code).toBe(2) })
  test('--out inside source/ or components/ is refused (exit 2) and nothing is written', async () => {
    fs.cpSync(PLUGIN, tmp, { recursive: true })
    const before = hashTree(tmp)
    for (const sub of ['source', 'components', path.join('source', 'nested')]) {
      const r = await run([tmp, '--out', path.join(tmp, sub)])
      expect(r.code).toBe(2)
    }
    expect(hashTree(tmp)).toBe(before)
  })
  test('relative --out source resolved from the cwd is refused', async () => {
    fs.cpSync(PLUGIN, tmp, { recursive: true })
    const cwd = process.cwd()
    process.chdir(tmp)
    try { expect((await run(['.', '--out', 'source'])).code).toBe(2) } finally { process.chdir(cwd) }
    expect(fs.existsSync(path.join(tmp, 'source', 'assess.json'))).toBe(false)
  })
})

describe('review fixes', () => {
  test('--out guard: symlink into source, case variant and a ..name sibling', async () => {
    fs.cpSync(PLUGIN, tmp, { recursive: true })
    const before = hashTree(tmp)
    const link = path.join(os.tmpdir(), `bt-assess-link-${process.pid}`)
    let linked = false
    try { fs.symlinkSync(path.join(tmp, 'source'), link, 'dir'); linked = true } catch (e) { /* no symlink right (windows) */ }
    try {
      if (linked) expect((await run([tmp, '--out', path.join(link, 'x')])).code).toBe(2)
    } finally { if (linked) fs.unlinkSync(link) }
    if (process.platform === 'darwin' || process.platform === 'win32') expect((await run([tmp, '--out', path.join(tmp, 'Source', 'x')])).code).toBe(2)
    expect(hashTree(tmp)).toBe(before)
    const ok = await run([tmp, '--out', path.join(tmp, 'source..cache')])
    expect(ok.code).toBe(0)
    const ok2 = await run([tmp, '--out', path.join(tmp, '..cache')])
    expect(ok2.code).toBe(0)
    expect(fs.existsSync(path.join(tmp, '..cache', 'assess.json'))).toBe(true)
  })
  test('sensitive or oversized files under source/ or components/ skip the census without opening them', async () => {
    fs.cpSync(PLUGIN, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'components', '.env'), 'fake-probe-0005')
    fs.mkdirSync(path.join(tmp, 'source', 'certs'))
    fs.writeFileSync(path.join(tmp, 'source', 'certs', 'a.pem'), 'fake-probe-0006')
    fs.writeFileSync(path.join(tmp, 'source', 'id_rsa'), 'fake-probe-0007')
    const opened = []
    const real = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...a) => { opened.push(String(p)); return real(p, ...a) })
    const r = await run([tmp, '--json'])
    expect(r.code).toBe(0)
    expect(opened.filter((p) => /\.env|\.pem|id_rsa/.test(p))).toEqual([])
    expect(r.out).not.toMatch(/fake-probe-000/)
    const rep = JSON.parse(r.out)
    expect(rep.census.error).toMatch(/census skipped/)
    expect(rep.recommendation.blockers.join(' ')).toMatch(/census/)
  })
  test('brighttest.json beats brighttest-ci.json; config.file is project-relative or null', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'brighttest-ci.json'), '{"a":1}')
    fs.writeFileSync(path.join(tmp, 'brighttest.json'), '{"z":1}')
    const r = await json(tmp)
    expect(r.brighttest.config.file).toBe('brighttest.json')
    expect(r.brighttest.config.keys).toEqual(['z'])
    const outside = path.join(os.tmpdir(), `bt-assess-cfg-${process.pid}.json`)
    fs.writeFileSync(outside, '{"q":1}')
    try {
      const o = await json(tmp, ['-c', outside])
      expect(o.brighttest.config.keys).toEqual(['q'])
      expect(o.brighttest.config.file).toBeNull()
    } finally { fs.rmSync(outside, { force: true }) }
  })
  test('greenfield boundary: 4 components is greenfield, 5 is brownfield', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.mkdirSync(path.join(tmp, 'components'))
    const comp = (i) => fs.writeFileSync(path.join(tmp, 'components', `C${i}.xml`), `<?xml version="1.0" encoding="utf-8" ?>\n<component name="C${i}" extends="Group"></component>\n`)
    for (let i = 1; i < assess.GREENFIELD_MAX_COMPONENTS; i++) comp(i)
    expect((await json(tmp)).recommendation.path).toBe('greenfield')
    comp(99)
    expect((await json(tmp)).recommendation.path).toBe('brownfield')
  })
  test('only the root .gitignore counts', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'source', '.gitignore'), '.env\n')
    expect((await json(tmp)).gitignore.present).toBe(false)
  })
})

// Left to ADOPT-05b: TP-ADOPT-05 secret cases (secrets[] entries with key and line only, dummy values from the
// legacy-app README never appear) and the risky-pattern scan.
