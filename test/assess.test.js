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
    expect(Array.isArray(r.secrets)).toBe(true)
    expect(r.scans.secrets.ran).toBe(true)
    expect(r.scans.risky.ran).toBe(true)
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
  test('--out inside a source/ that is itself a symlink is refused', async () => {
    const real = path.join(tmp, 'real-src'), app = path.join(tmp, 'app')
    fs.mkdirSync(real); fs.mkdirSync(app)
    fs.writeFileSync(path.join(app, 'manifest'), 'title=x\n')
    try { fs.symlinkSync(real, path.join(app, 'source'), 'dir') } catch (e) { return }
    expect((await run([app, '--out', path.join(app, 'source', 'out')])).code).toBe(2)
    expect(fs.readdirSync(real)).toEqual([])
  })
  test('Certs/ in any case is skipped and never read', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    for (const d of ['Certs', path.join('source', 'CERTS')]) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true })
      fs.writeFileSync(path.join(tmp, d, 'bsconfig.json'), '{"x":"fake-probe-0008"}')
      fs.writeFileSync(path.join(tmp, d, 'brighttest.json'), '{"x":"fake-probe-0009"}')
    }
    const opened = []
    const real = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...a) => { opened.push(String(p)); return real(p, ...a) })
    const r = await run([tmp, '--json'])
    expect(r.code).toBe(0)
    expect(opened.filter((p) => /certs/i.test(p))).toEqual([])
    expect(JSON.parse(r.out).census.error).toMatch(/census skipped/)
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

const SCANS = path.join(FIX, 'scans-app')
const FAKE_VALUES = ['fake-token-value-0001', 'fake-secret-value-0002', 'fake-pass-0003', 'fake0123456789abcdefABCDEF']

describe('ADOPT-05b secret scan', () => {
  test('reports key names and file:line, never a value, in stdout, JSON or Markdown', async () => {
    const out = path.join(tmp, 'out')
    const j = await run([SCANS, '--json', '--out', out])
    const h = await run([SCANS])
    const rep = JSON.parse(j.out)
    expect(rep.secrets).toEqual([
      { file: 'source/Config.brs', line: 3, key: 'apiToken', kind: 'assignment' },
      { file: 'source/Config.brs', line: 8, key: 'clientSecret', kind: 'assignment' },
      { file: 'source/Config.brs', line: 9, key: null, kind: 'url-credentials' },
      { file: 'source/Config.brs', line: 10, key: null, kind: 'bearer-literal' },
    ])
    for (const x of rep.secrets) expect(Object.keys(x).sort()).toEqual(['file', 'key', 'kind', 'line'])
    const md = fs.readFileSync(path.join(out, 'assess.md'), 'utf8')
    expect(md).toContain('source/Config.brs:3 apiToken (assignment)')
    expect(h.out).toContain('source/Config.brs:3 apiToken')
    const everything = [j.out, j.err, h.out, md, ...fs.readdirSync(out).map((f) => fs.readFileSync(path.join(out, f), 'utf8'))].join('\n')
    for (const v of FAKE_VALUES) expect(everything).not.toContain(v)
  })
  test('placeholders and non-secret keys are not findings; a secret in a comment still is', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'source', 'ok.brs'), [
      'a.password = "${PASSWORD}"', 'a.authType = "basic"', "' a.token = \"fake-commented-value\"x", 'a.token = ""', 'a.title = "Plain title"',
    ].join('\n') + '\n')
    const r = await json(tmp)
    expect(r.secrets.filter((x) => x.line !== 4)).toEqual([{ file: 'source/ok.brs', line: 3, key: 'token', kind: 'assignment' }])
    expect(r.secrets.length).toBe(1)
  })
  test('long values, values with spaces, XML id/value pairs and tighter key names', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    const jwt = 'fakejwt' + 'a'.repeat(600)
    fs.writeFileSync(path.join(tmp, 'source', 'k.brs'), [
      `a.accessToken = "${jwt}"`, 'a.passphrase = "fake pass phrase here"', 'a.author = "Someone Else"', 'a.passThrough = "abcdefgh"', 'a.compass = "abcdefgh"', 'a.api_key = "fake-key-0009"',
    ].join('\n') + '\n')
    fs.mkdirSync(path.join(tmp, 'components'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'components', 'F.xml'), '<component name="F" extends="Group">\n<interface><field id="apiKey" type="string" value="fake-xml-0011" /></interface>\n</component>\n')
    const r = await json(tmp)
    expect(r.secrets.map((x) => `${x.file}:${x.line}:${x.key}`)).toEqual(['components/F.xml:2:apiKey', 'source/k.brs:1:accessToken', 'source/k.brs:2:passphrase', 'source/k.brs:6:api_key'])
    expect(JSON.stringify(r)).not.toMatch(/fakejwt|fake pass|fake-xml|fake-key-0009/)
  })
  test('key name rule: compound one-word keys are flagged; author, compass, passThrough, authStatus are not', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    const yes = ['apitoken', 'authtoken', 'accesstoken', 'secretkey', 'clientsecret', 'devicepassword', 'APIToken', 'AUTHTOKEN', 'JWTToken', 'password', 'apiKey', 'api_key', 'secretToken', 'SECRET_KEY', 'ROKU_PASSWORD', 'privateKey']
    const no = ['author', 'compass', 'passThrough', 'authStatus']
    fs.writeFileSync(path.join(tmp, 'source', 'k.brs'), [...yes, ...no].map((k) => `a.${k} = "fake-value-0012"`).join('\n') + '\n')
    fs.mkdirSync(path.join(tmp, 'components'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'components', 'F.xml'), '<component name="F" extends="Group">\n<field value="fake-xml-0013" id="apiKey" type="string" />\n<field id="authStatus" value="pending" />\n</component>\n')
    const r = await json(tmp)
    expect(r.secrets.filter((x) => x.file === 'source/k.brs').map((x) => x.key)).toEqual(yes)
    expect(r.secrets.filter((x) => x.file === 'components/F.xml').map((x) => `${x.line}:${x.key}`)).toEqual(['2:apiKey'])
  })
  test('lines over the limit are counted, and a long URL-like line is scanned fast', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'source', 'long.brs'), 'a = "' + 'http://a:'.repeat(700) + '"\nb = "' + 'x'.repeat(5000) + '"\n')
    const t0 = Date.now()
    const r = await json(tmp)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.scans.secrets.skippedLongLines).toBe(2)
    expect(r.scans.risky.skippedLongLines).toBe(2)
  })
  test('a private key block is reported without a key', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'manifest'), fs.readFileSync(path.join(tmp, 'manifest'), 'utf8') + '# -----BEGIN RSA PRIVATE KEY-----\n')
    expect((await json(tmp)).secrets.map((x) => x.kind)).toEqual(['private-key'])
  })
})

describe('ADOPT-05b risky-pattern scan', () => {
  const kindsFor = async (name, body, extra = {}) => {
    const d = path.join(tmp, `p-${name}`)
    fs.cpSync(SKELETON, d, { recursive: true })
    fs.writeFileSync(path.join(d, 'source', 'probe.brs'), body + '\n')
    for (const [f, c] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c) }
    return (await json(d)).risky.filter((x) => x.file !== 'source/main.brs')
  }
  const cases = {
    'eval': ['r = Eval("1+1")', 'r = evaluate(1)'],
    'roInput-unknown-keys': ['p = CreateObject("roInput")\ni = e.getInfo()', 'i = e.getInfo()'],
    'render-thread-sync-http': ['t = x.GetToString()', "' t = x.GetToString()"],
    'logs-deeplink-params': ['print args.contentId', 'print "contentId"'],
    'logs-deeplink-params (? shorthand)': ['? args.contentId', '? "contentId"'],
  }
  for (const [label, [pos, neg]] of Object.entries(cases)) {
    const kind = label.split(' ')[0]
    const tag = label.replace(/\W+/g, '-')
    test(`${label}: one positive and one negative line`, async () => {
      const hits = await kindsFor(`${tag}-pos`, pos)
      expect(hits.filter((x) => x.kind === kind).length).toBe(1)
      expect(hits.find((x) => x.kind === kind).file).toBe('source/probe.brs')
      expect((await kindsFor(`${tag}-neg`, neg)).filter((x) => x.kind === kind)).toEqual([])
    })
  }
  const task = { 'components/T.xml': '<component name="T" extends="Task"><script uri="pkg:/source/probe.brs"/></component>\n' }
  test('a trailing `: rem` comment and BrighterScript backtick strings are not code', async () => {
    expect((await kindsFor('cm1', 'x = 1 : rem r = Eval("1")')).filter((x) => x.kind === 'eval')).toEqual([])
    expect((await kindsFor('cm2', 'x = `r = Eval(1)`')).filter((x) => x.kind === 'eval')).toEqual([])
    expect((await kindsFor('cm3', 'x = 1 : r = Eval("1")')).filter((x) => x.kind === 'eval').length).toBe(1)
  })
  test('task-infinite-loop: positive in a Task script, negative for a bounded loop or a non-Task script', async () => {
    expect((await kindsFor('tl-pos', 'while true\nend while', task)).filter((x) => x.kind === 'task-infinite-loop')).toEqual([{ kind: 'task-infinite-loop', file: 'source/probe.brs', line: 1 }])
    expect((await kindsFor('tl-neg', 'while i < 3\nend while', task)).filter((x) => x.kind === 'task-infinite-loop')).toEqual([])
    const normal = 'while true\n  msg = wait(0, port)\n  if msg = invalid then exit while\nend while'
    expect((await kindsFor('tl-neg3', normal, task)).filter((x) => x.kind === 'task-infinite-loop')).toEqual([])
    expect((await kindsFor('tl-neg2', 'while true\nend while')).filter((x) => x.kind === 'task-infinite-loop')).toEqual([])
  })
  test('render-thread-sync-http is not reported inside a Task script', async () => {
    expect((await kindsFor('rt-task', 'x.GetToString()', task)).filter((x) => x.kind === 'render-thread-sync-http')).toEqual([])
  })
  test(`large-global: more than ${assess.LARGE_GLOBAL_FIELDS} distinct fields is one finding at the first one`, async () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => `m.global.f${i} = ${i}`).join('\n')
    expect((await kindsFor('lg-pos', mk(assess.LARGE_GLOBAL_FIELDS + 1))).filter((x) => x.kind === 'large-global')).toEqual([{ kind: 'large-global', file: 'source/probe.brs', line: 1 }])
    expect((await kindsFor('lg-neg', mk(assess.LARGE_GLOBAL_FIELDS))).filter((x) => x.kind === 'large-global')).toEqual([])
  })
  test('fixture finds every kind once and the Markdown lists them with file:line', async () => {
    const out = path.join(tmp, 'o')
    const rep = JSON.parse((await run([SCANS, '--json', '--out', out])).out)
    expect(rep.risky.map((x) => x.kind).sort()).toEqual(['eval', 'logs-deeplink-params', 'render-thread-sync-http', 'roInput-unknown-keys', 'task-infinite-loop'].sort())
    const md = fs.readFileSync(path.join(out, 'assess.md'), 'utf8')
    expect(md).toContain('## Risky patterns')
    expect(md).toContain('source/main.brs:3 eval')
  })
})

describe('ADOPT-05b follow-ups', () => {
  test('the file cap is reported once, with its own wording', async () => {
    fs.cpSync(SKELETON, tmp, { recursive: true })
    fs.mkdirSync(path.join(tmp, 'components', 'a'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'components', 'b'), { recursive: true })
    for (let i = 0; i <= assess.MAX_FILES; i++) fs.writeFileSync(path.join(tmp, 'components', i % 2 ? 'a' : 'b', `f${i}.txt`), '')
    const r = await json(tmp)
    expect(r.census.error.match(/20,000/g).length).toBe(1)
    expect(r.recommendation.blockers.filter((b) => /20,000/.test(b)).length).toBe(1)
    expect(r.census.error).toMatch(/file cap reached/)
    expect(r.project.files.truncated).toBe(true)
  }, 60000)
  test('--out on an existing file, or under one, is a usage error (exit 2)', async () => {
    fs.cpSync(SKELETON, path.join(tmp, 'app'), { recursive: true })
    const f = path.join(tmp, 'file.txt')
    fs.writeFileSync(f, 'keep')
    for (const target of [f, path.join(f, 'sub')]) {
      const r = await run([path.join(tmp, 'app'), '--out', target])
      expect(r.code).toBe(2)
      expect(r.err).toMatch(/--out/)
    }
    expect(fs.readFileSync(f, 'utf8')).toBe('keep')
  })
  test('without --out nothing is written and the Markdown is not produced', async () => {
    const before = hashTree(SCANS)
    await run([SCANS])
    expect(hashTree(SCANS)).toBe(before)
  })
  test('an empty directory is not-a-roku-app', async () => {
    fs.mkdirSync(path.join(tmp, 'empty'))
    expect((await json(path.join(tmp, 'empty'))).recommendation.path).toBe('not-a-roku-app')
  })
})

// TP-ADOPT-05 coverage: covered here are exit 0, no network or subprocess (spies), tree unchanged without --out, no
// secret value found (fixture values, .env probe-0001, devices cache), and secrets[] entries with key and line.
// Left out: the NODE_OPTIONS block-net.js preload run and the legacy-app README dummy values grep (pack-run steps).

describe('ADOPT-26 (bsconfig rootDir and files are blockers)', () => {
  const BSC = path.join(ROOT, 'examples', 'bsconfig-plugin-app')
  test('rootDir src app: census follows it as a hint, blocker says build uses brighttest.json', async () => {
    const r = await json(BSC)
    const b = r.recommendation.blockers.join('\n')
    expect(r.census.scenes).toBe(1)
    expect(b).toMatch(/bsconfig rootDir is read by the census as a hint only.*: "src"/)
    expect(b).toMatch(/bsconfig files list is not honored.*3 entries/)
  })
  test('no rootDir blocker when brighttest.json repeats the bsconfig rootDir', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'rdok-'))
    fs.mkdirSync(path.join(d, 'src', 'source'), { recursive: true })
    fs.writeFileSync(path.join(d, 'src', 'manifest'), 'title=T\n')
    fs.writeFileSync(path.join(d, 'src', 'source', 'main.brs'), 'sub main()\nend sub\n')
    fs.writeFileSync(path.join(d, 'bsconfig.json'), JSON.stringify({ rootDir: 'src' }))
    fs.writeFileSync(path.join(d, 'brighttest.json'), JSON.stringify({ rootDir: 'src' }))
    const r = await json(d)
    expect(r.recommendation.blockers.join('\n')).not.toMatch(/rootDir/)
  })
  const mkApp = (name, sub) => {
    const d = fs.mkdtempSync(path.join(tmp, name))
    const b = sub ? path.join(d, sub) : d
    fs.mkdirSync(path.join(b, 'source'), { recursive: true })
    fs.mkdirSync(path.join(b, 'components'), { recursive: true })
    fs.writeFileSync(path.join(b, 'manifest'), 'title=T\n')
    fs.writeFileSync(path.join(b, 'source', 'main.brs'), 'sub main()\nend sub\n')
    fs.writeFileSync(path.join(b, 'components', 'S.xml'), '<component name="S" extends="Scene"></component>\n')
    return d
  }
  test('guard follows the census effective root (brighttest.json rootDir and bsconfig rootDir)', async () => {
    const d = mkApp('g1-', 'app'); fs.writeFileSync(path.join(d, 'brighttest.json'), '{"rootDir":"app"}')
    fs.writeFileSync(path.join(d, 'app', 'source', '.env'), 'K=v'); fs.writeFileSync(path.join(d, 'app', 'source', 'dev.key'), 'k')
    const r = await json(d)
    expect(r.census.error).toMatch(/census skipped: sensitive/)
    expect(r.recommendation.path).not.toBe('not-a-roku-app')
    const e = mkApp('g2-', 'src'); fs.writeFileSync(path.join(e, 'bsconfig.json'), '{"rootDir":"src"}')
    fs.writeFileSync(path.join(e, 'src', 'source', '.env'), 'K=v')
    expect((await json(e)).census.error).toMatch(/census skipped: sensitive/)
  })
  test('extends never opens a non-json file', async () => {
    const d = mkApp('x1-', 'src'); fs.writeFileSync(path.join(d, '.env'), '{"rootDir":"src"}'); fs.writeFileSync(path.join(d, 'bsconfig.json'), '{"extends":".env"}')
    const r = await json(d)
    expect(r.recommendation.blockers.join('\n')).not.toMatch(/rootDir is read/)
  })
  test('brighttest.json rootDir is resolved once (src and src/src)', async () => {
    const d = mkApp('dbl-', 'src'); fs.writeFileSync(path.join(d, 'brighttest.json'), '{"rootDir":"src"}')
    const r = await json(d)
    expect(r.census.scenes).toBe(1)
  })
  test('brighttest.json-only and extends-only rootDir keep the recommendation and the hint', async () => {
    const d = mkApp('bo-', 'app'); fs.writeFileSync(path.join(d, 'brighttest.json'), '{"rootDir":"app"}')
    const r = await json(d)
    expect(r.recommendation.path).not.toBe('not-a-roku-app'); expect(r.census.scenes).toBe(1)
    const e = mkApp('eo-', 'src'); fs.writeFileSync(path.join(e, 'base.json'), '{"rootDir":"src"}'); fs.writeFileSync(path.join(e, 'bsconfig.json'), '{"extends":"./base.json"}')
    const r2 = await json(e)
    expect(r2.recommendation.path).not.toBe('not-a-roku-app'); expect(r2.census.scenes).toBe(1)
    expect(r2.recommendation.blockers.join('\n')).toMatch(/rootDir is read by the census as a hint only.*: "src"/)
  })
  test('absolute brighttest.json rootDir at the same folder and src/./ raise no blocker', async () => {
    const d = mkApp('abs-', 'src'); fs.writeFileSync(path.join(d, 'bsconfig.json'), '{"rootDir":"src/./"}')
    fs.writeFileSync(path.join(d, 'brighttest.json'), JSON.stringify({ rootDir: path.join(d, 'src') }))
    expect((await json(d)).recommendation.blockers.join('\n')).not.toMatch(/rootDir/)
  })
  test('rootDir pointing elsewhere is named as outside the root and never read', async () => {
    for (const rd of ['..', '../x', '/etc', 'C:/Windows']) {
      const d = fs.mkdtempSync(path.join(tmp, 'rd-'))
      fs.writeFileSync(path.join(d, 'manifest'), 'title=T\n')
      fs.writeFileSync(path.join(d, 'bsconfig.json'), JSON.stringify({ rootDir: rd }))
      const r = await json(d)
      const b = r.recommendation.blockers.join('\n')
      expect(b).toMatch(/rootDir is read by the census as a hint only.*outside the project root, not read/)
      expect(b).not.toContain(rd)
    }
  })
  test('manifest app with 0 scenes and no rootDir gets a census blocker', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'z-'))
    fs.writeFileSync(path.join(d, 'manifest'), 'title=T\n')
    fs.mkdirSync(path.join(d, 'source'))
    fs.writeFileSync(path.join(d, 'source', 'main.brs'), 'sub main()\nend sub\n')
    const r = await json(d)
    expect(r.recommendation.blockers.join('\n')).toMatch(/census found 0 scenes/)
  })
  test('a rootDir of .. never reads or lists a marker file outside the root', async () => {
    const outer = fs.mkdtempSync(path.join(tmp, 'outer-'))
    fs.writeFileSync(path.join(outer, 'manifest'), 'title=OUTSIDE_MARKER\n')
    fs.writeFileSync(path.join(outer, 'OUTSIDE_MARKER.brs'), "password = \"outsidemarkersecret\"\n")
    const d = path.join(outer, 'app')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'bsconfig.json'), JSON.stringify({ rootDir: '..' }))
    const o = (await run([d, '--json'])).out
    expect(o).not.toMatch(/OUTSIDE_MARKER|outsidemarkersecret/)
    expect(JSON.parse(o).project.isRokuApp).toBe(false)
  })
  test('rootDir src with src/manifest is honored: no rootDir blocker', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'rs-'))
    fs.mkdirSync(path.join(d, 'src', 'source'), { recursive: true })
    fs.writeFileSync(path.join(d, 'src', 'manifest'), 'title=T\n')
    fs.writeFileSync(path.join(d, 'src', 'source', 'main.brs'), 'sub main()\nend sub\n')
    fs.writeFileSync(path.join(d, 'bsconfig.json'), JSON.stringify({ rootDir: 'src' }))
    const r = await json(d)
    expect(r.project.isRokuApp).toBe(true)
    expect(r.recommendation.blockers.join('\n')).not.toMatch(/rootDir is not honored/)
  })
  const withFiles = async (files) => {
    const d = fs.mkdtempSync(path.join(tmp, 'f-'))
    fs.writeFileSync(path.join(d, 'manifest'), 'title=T\n')
    fs.writeFileSync(path.join(d, 'bsconfig.json'), JSON.stringify({ files }))
    return json(d)
  }
  test('files with a { src, dest } object is a blocker', async () => {
    const r = await withFiles(['manifest', { src: '../lib/**', dest: 'source' }])
    expect(r.recommendation.blockers.join('\n')).toMatch(/files list is not honored.*2 entries/)
  })
  test('files equal to the bsc defaults is not a blocker but a confirm', async () => {
    const r = await withFiles(['manifest', 'source/**/*.*', 'components/**/*.*', 'images/**/*.*', 'locale/**/*', 'manifest'])
    expect(r.recommendation.blockers.join('\n')).not.toMatch(/files list/)
    expect(r.recommendation.unknowns.join('\n')).toMatch(/files list matches the bsc defaults: confirm/)
  })
  test('default list plus an extra entry or a looser glob is a blocker', async () => {
    const r = await withFiles(['manifest', 'source/**/*.*', 'fonts/**/*'])
    expect(r.recommendation.blockers.join('\n')).toMatch(/files list is not honored/)
    const r2 = await withFiles(['manifest', 'source/**'])
    expect(r2.recommendation.blockers.join('\n')).toMatch(/files list is not honored/)
  })
  test('rootDir with a newline is echoed escaped, not as a fake line', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'nl-'))
    fs.writeFileSync(path.join(d, 'manifest'), 'title=T\n')
    fs.writeFileSync(path.join(d, 'bsconfig.json'), JSON.stringify({ rootDir: 'a\nFAKE: line' }))
    const out = (await run([d])).out
    expect(out).not.toMatch(/^FAKE: line/m)
  })
})

describe('ADOPT-29 census error redaction', () => {
  const censusMod = require('../lib/instrument/census')
  const fail = (msg) => vi.spyOn(censusMod, 'census').mockRejectedValue(new Error(msg))
  const mkApp = () => { const d = path.join(tmp, 'app'); fs.cpSync(SKELETON, d, { recursive: true }); return d }

  test('absolute project path and home directory become <path> in blocker, markdown, text and json', async () => {
    const app = mkApp()
    const home = os.homedir()
    fail(`Cannot find module 'x'\nRequire stack:\n- ${path.join(app, 'components', 'A.brs')}\n- ${home}/work/node_modules/y/index.js\n  at ${home}/z.js:12:3`)
    const r = await json(app)
    const all = JSON.stringify(r)
    expect(all).not.toContain(app)
    expect(all).not.toContain(home)
    expect(all).not.toMatch(/"?[^\w<]\/(?:Users|home|var|tmp|private)\//)
    expect(r.census.error).toContain('<path>/components/A.brs')
    expect(r.census.error).toContain('<path>/index.js')
    expect(r.census.error).toContain("Cannot find module 'x'")
    expect(r.recommendation.blockers.join('\n')).toMatch(/census could not parse the project: Cannot find module/)
    const md = (await run([app])).out
    expect(md).toContain('<path>')
    expect(md).not.toContain(home)
    expect(md).not.toContain(app)
  })
  test('an error without paths is unchanged', async () => {
    const app = mkApp()
    fail('bad token at source/main.brs line 4 and/or more')
    const r = await json(app)
    expect(r.census.error).toBe('bad token at source/main.brs line 4 and/or more')
  })
  test('ADOPT-29 review: home folders, sibling roots, spaces, UNC, URLs and division', async () => {
    const app = mkApp()
    const home = os.homedir()
    fail([
      `a ${home}/clients/AcmeCo/tool/b.js`,
      `b ${app}2/AcmeClient/a.js`,
      'c /Volumes/Client Drive/AcmeCo App/c.js: boom',
      'd \\\\fileserver\\share\\AcmeCo\\d.js',
      'e https://example.com/x/y and 1 / 2 and and/or',
      `f ${path.join(app, 'components', 'A.brs')}:3:1`,
    ].join('\n'))
    const e = (await json(app)).census.error.split('\n')
    expect(e[0]).toBe('a <path>/b.js')
    expect(e[1]).toBe('b <path>/a.js')
    expect(e[2]).toBe('c <path>/c.js: boom')
    expect(e[3]).toBe('d <path>/d.js')
    expect(e[4]).toBe('e https://example.com/x/y and 1 / 2 and and/or')
    expect(e[5]).toBe('f <path>/components/A.brs:3:1')
  })
  test('redactPathsWith handles win32-style roots and case-insensitive compare', () => {
    const r = assess.redactPathsWith
    const root = 'C:\\Users\\Dev\\app'
    expect(r('x C:\\Users\\Dev\\app\\components\\A.brs:3:1', [root], true)).toBe('x <path>/components/A.brs:3:1')
    expect(r('x c:/users/dev/APP/components/A.brs', [root], true)).toBe('x <path>/components/A.brs')
    expect(r('x C:\\Users\\Dev\\app2\\z\\a.js', [root], true)).toBe('x <path>/a.js')
    expect(r('x C:\\Users\\Dev\\other\\b.js', [root], true)).toBe('x <path>/b.js')
    expect(r('x /tmp/App/A.brs', ['/tmp/app'], false)).toBe('x <path>/A.brs')
    expect(r('x /tmp/app/A.brs', ['/tmp/app'], false)).toBe('x <path>/A.brs')
    expect(r('x /tmp/app/sub/A.brs', ['/tmp/app'], false)).toBe('x <path>/sub/A.brs')
  })
})
