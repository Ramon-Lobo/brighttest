import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// STA-S-T1: agent runtime v0. Serializer specs run headless on the fork engine (brs-cli); plugin AST tests check the Scene
// bootstrap and the agent components. Device behavior (Label readable through ECP, Task timing) is not covered here.
const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const pluginPath = path.resolve(__dirname, '../lib/instrument/plugin.js')
const createPlugin = require(pluginPath)
const brsCli = path.resolve(__dirname, '../node_modules/@ramonlobo/brs-node/bin/brs.cli.js')
const RT = path.resolve(__dirname, '../lib/instrument/runtime')
const CORE = fs.readFileSync(path.join(RT, 'source/bt/BT_core.brs'), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-agent-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function runBrs(name, cfgBody, mainBody) {
  const file = path.join(tmp, name + '.brs')
  fs.writeFileSync(file, `function BT_config() as object\n    return ${cfgBody}\nend function\n${CORE}\nsub main()\n${mainBody}\nend sub\n`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}
const lineAfter = (out, tag) => { const l = out.split(/\r?\n/).find((x) => x.startsWith(tag)); return l ? l.slice(tag.length) : null }

const SAMPLE = [
  '    deep = {a: 1}',
  '    for i = 1 to 9 : deep = {n: deep} : end for',
  '    big = []',
  '    for i = 1 to 60 : big.push(i) : end for',
  '    src = { deep: deep, big: big, s: string(3000, "x"), fn: sub() : end sub, auth_token: "zz", pw: { password: "p" }, user: { email: "e@x", name: "n" }, nul: invalid, ok: true, f: 1.5, dt: CreateObject("roDateTime") }',
  '    tr = []',
  '    o = BT_serialize(src, BT_capsDefault(), "global", 0, tr, ["global.user.email"])',
  '    print "J:" + FormatJson(o)',
  '    print "T:" + FormatJson(tr)',
  '    nd = CreateObject("roSGNode", "Node") : nd.id = "abc"',
  '    print "N:" + FormatJson(BT_serialize({ n: nd }, BT_capsDefault(), "g", 0, [], invalid))',
].join('\n')

describe('BT_core serializer (headless, fork engine)', () => {
  let out
  beforeAll(async () => { out = await runBrs('sample', '{ caps: {}, publish: {} }', SAMPLE) }, 30000)

  it('caps depth, array items and string length, and names every cut in truncated', () => {
    const j = JSON.parse(lineAfter(out, 'J:'))
    const t = JSON.parse(lineAfter(out, 'T:'))
    expect(j.big).toHaveLength(50)
    expect(j.s).toHaveLength(2048)
    let d = j.deep; let levels = 0
    while (typeof d === 'object' && d !== null) { d = d.n; levels++ }
    expect(d).toBe('$truncated:depth')
    expect(levels).toBe(5) // root layer + 5 nested containers = depth 6
    expect(t).toEqual(['global.big:items', 'global.deep.n.n.n.n.n:depth', 'global.s:string'])
  })
  it('maps types: nodes, unsupported values, invalid, scalars', () => {
    const j = JSON.parse(lineAfter(out, 'J:'))
    expect(j.fn).toBe('$type:Function')
    expect(j.dt).toBe('$type:roDateTime')
    expect(j.nul).toBeNull()
    expect(j.ok).toBe(true)
    expect(j.f).toBe(1.5)
    expect(JSON.parse(lineAfter(out, 'N:'))).toEqual({ n: { $node: 'abc', subtype: 'Node' } })
  })
  it('redacts secret-looking keys and configured paths', () => {
    const raw = lineAfter(out, 'J:')
    const j = JSON.parse(raw)
    expect(j.auth_token).toBe('<redacted:auth_token>')
    expect(j.pw.password).toBe('<redacted:password>')
    expect(j.user.email).toBe('<redacted:email>')
    expect(j.user.name).toBe('n')
    expect(raw).not.toContain('"zz"')
  })
  it('is deterministic: two runs give identical output', async () => {
    const again = await runBrs('sample2', '{ caps: {}, publish: {} }', SAMPLE)
    expect(lineAfter(again, 'J:')).toBe(lineAfter(out, 'J:'))
  }, 30000)
})

describe('BT_labelJson maxBytes (headless)', () => {
  const STUB = [
    'function BT_nodeFields(node as dynamic) as object',
    '    g = {}',
    '    if type(node) <> "String" then return g',
    '    for i = 1 to 220 : g["k" + Right("000" + i.toStr(), 3)] = string(900, "y") : end for',
    '    return g',
    'end function',
  ].join('\n')
  const run = async (name, cfg) => {
    const file = path.join(tmp, name + '.brs')
    const core = CORE.replace(/function BT_nodeFields[\s\S]*?end function/, STUB)
    fs.writeFileSync(file, `function BT_config() as object\n    return ${cfg}\nend function\n${core}\nsub main()\n    raw = BT_labelJson(7, \"G\", invalid, BT_config(), 2)\n    j = ParseJson(raw)\n    print "B:" + Len(raw).toStr()\n    print "T:" + j.truncated.count().toStr()\n    gl = j.snapshot.layers.global\n    if gl <> invalid then\n        print "K:" + gl.count().toStr()\n        print "M:" + (gl.k001 = "$truncated:bytes").toStr()\n    end if\nend sub\n`)
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
      let o = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
      child.stdout.on('data', (d) => { o += d }); child.stderr.on('data', (d) => { o += d })
      child.on('close', () => { clearTimeout(timer); resolve(o) })
    })
  }

  it('64 KB default: valid JSON, at most 65,536 bytes, truncation recorded, not an error', async () => {
    const o = await run('cap64', '{ caps: {}, publish: {} }')
    expect(Number(lineAfter(o, 'B:'))).toBeLessThanOrEqual(65536) // ParseJson succeeded inside the program: valid JSON
    expect(Number(lineAfter(o, 'B:'))).toBeGreaterThan(30000)
    expect(Number(lineAfter(o, 'T:'))).toBeGreaterThan(0)
    expect(lineAfter(o, 'M:').trim()).toBe('true') // the largest-first cut replaced entries with the marker
  }, 30000)
  it('256 KB: the same snapshot fits whole', async () => {
    const o = await run('cap256', '{ caps: {}, publish: { maxBytes: 262144 } }')
    expect(Number(lineAfter(o, 'B:'))).toBeLessThanOrEqual(262144)
    expect(Number(lineAfter(o, 'T:'))).toBe(0)
    expect(Number(lineAfter(o, 'K:'))).toBe(220)
    expect(lineAfter(o, 'M:').trim()).toBe('false')
  }, 30000)
  it('a tiny cap still yields valid JSON within the cap', async () => {
    const o = await run('cap1k', '{ caps: {}, publish: { maxBytes: 1024 } }')
    expect(Number(lineAfter(o, 'B:'))).toBeLessThanOrEqual(1024)
    expect(Number(lineAfter(o, 'T:'))).toBeGreaterThan(0)
  }, 30000)
})

// ---- plugin AST tests ---------------------------------------------------------------------------------------------
const CONFIG = '#if BT_AGENT\nfunction BT_config() as object\n    return { token: "t", hub: { host: "auto", port: 8790 }, features: { net: true, state: true, op: true }, caps: {} }\nend function\n#end if\n'
const XML = (name, ext, extra = '') => `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}"><script type="text/brightscript" uri="pkg:/components/${name}.brs"/>${extra}</component>\n`
function mkapp(name, files) {
  const dir = path.join(tmp, 'src-' + name)
  const all = { manifest: 'title=T\nmajor_version=1\nminor_version=0\nbuild_version=1\n', 'source/main.brs': 'sub main()\nend sub\n', ...files }
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
async function build(dir, name, extra = {}) {
  const out = path.join(tmp, 'out-' + name)
  const pb = new ProgramBuilder()
  await pb.run({
    cwd: dir, rootDir: dir, stagingDir: path.join(out, 'staging'), createPackage: false, copyToStaging: true,
    files: ['manifest', 'source/**/*', 'components/**/*'], plugins: [pluginPath], logLevel: 'error',
    autoImportComponentScript: false, diagnosticFilters: [1107, 1009], ...extra,
  })
  const errors = pb.program.getDiagnostics().filter((d) => d.severity === 1).map((d) => `${d.code} ${d.message}`)
  return { staging: path.join(out, 'staging'), errors, result: createPlugin.lastInstance.getResult() }
}
const read = (b, rel) => fs.readFileSync(path.join(b.staging, rel), 'utf8')
const has = (b, rel) => fs.existsSync(path.join(b.staging, rel))

const SCENE_APP = {
  'source/bt/BT_config.brs': CONFIG,
  'components/Scn.xml': XML('Scn', 'Scene'),
  'components/Scn.brs': 'sub init()\n    m.x = 1\nend sub\n',
  'components/Grp.xml': XML('Grp', 'Group'),
  'components/Grp.brs': 'sub init()\n    m.y = 1\nend sub\n',
}

describe('Scene bootstrap and agent components (plugin AST)', () => {
  it('bootstraps the Scene only, stages the agent components, and the output compiles', async () => {
    const b = await build(mkapp('scene', SCENE_APP), 'scene')
    expect(b.errors).toEqual([])
    expect(read(b, 'components/Scn.brs')).toMatch(/sub init\(\) : BT_bootstrap\(m\.top\)/)
    expect(read(b, 'components/Grp.brs')).not.toContain('BT_bootstrap')
    for (const f of ['BT_Agent.xml', 'BT_Agent.brs', 'BT_AgentTask.xml', 'BT_AgentTask.brs']) expect(has(b, 'components/bt/' + f), f).toBe(true)
    const rt = read(b, 'source/bt/BT_runtime.brs')
    expect(rt).toContain('top.createChild("BT_Agent")')
    expect(rt).toContain('if not top.isSubtype("Scene") then return')
    expect(rt).toContain('function BT_serialize(')
    expect(rt.match(/^#if BT_AGENT/gm)).toHaveLength(1)
    expect(b.result.bootstrapped.map((x) => x.file)).toEqual(['components/Scn.brs'])
  })
  it('a base and a derived Scene share one bootstrap call (guard keeps one agent)', async () => {
    const files = {
      ...SCENE_APP,
      'components/Der.xml': XML('Der', 'Scn'),
      'components/Der.brs': 'sub init()\n    m.z = 1\nend sub\n',
    }
    const b = await build(mkapp('derived', files), 'derived')
    expect(b.errors).toEqual([])
    const all = ['Scn', 'Der'].map((n) => read(b, `components/${n}.brs`)).join('\n')
    expect((all.match(/BT_bootstrap\(m\.top\)/g) || []).length).toBe(2) // both inits call it; the `__bt_boot` guard makes the second a no-op
    expect(read(b, 'source/bt/BT_runtime.brs')).toContain('if top.hasField("__bt_boot") then return')
  })
  it('instrument.scene=false and a build without BT_config keep the skeleton: no agent components', async () => {
    const off = await build(mkapp('off', SCENE_APP), 'off', { instrument: { scene: false } })
    expect(has(off, 'components/bt/BT_Agent.xml')).toBe(false)
    expect(read(off, 'source/bt/BT_runtime.brs')).not.toContain('BT_Agent')
    const { 'source/bt/BT_config.brs': _c, ...noCfg } = SCENE_APP
    const b = await build(mkapp('nocfg', noCfg), 'nocfg')
    expect(has(b, 'components/bt/BT_Agent.xml')).toBe(false)
    expect(read(b, 'source/bt/BT_runtime.brs')).not.toContain('BT_Agent')
  })
  it('the runtime names are reserved: a user BT_labelJson fails the build (BT9001)', async () => {
    const b = await build(mkapp('res', { ...SCENE_APP, 'source/u.brs': 'function BT_labelJson() as string\n    return ""\nend function\n' }), 'res')
    expect(b.errors.some((e) => e.startsWith('BT9001'))).toBe(true)
  })
})

describe('agent is read-only in v0', () => {
  it('no write path in the agent components or the serializer', () => {
    const src = ['source/bt/BT_core.brs', 'components/bt/BT_Agent.brs', 'components/bt/BT_AgentTask.brs']
      .map((f) => fs.readFileSync(path.join(RT, f), 'utf8')).join('\n')
    // STA-S-T1b: the registry layer reads sections with roRegistrySection (GetKeyList/Read); every other registry class stays out
    expect(src.replace(/roRegistrySection/g, '')).not.toMatch(/roRegistry/i)
    expect(src).not.toMatch(/\.Flush\(|\.setField\(|\.update\(|\.callFunc\(|\.write\(|\.delete\(|roUrlTransfer/i)
    expect(src).not.toMatch(/m\.global\.[A-Za-z_]+\s*=/)
    expect(src).not.toMatch(/m\.global\.(add|set)Field/i)
  })
})
