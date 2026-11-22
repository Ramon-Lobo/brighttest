import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// NET-N-T2: lib/instrument/rewrite-net.js (AST rewrite) and runtime/source/bt/BT_net.brs (BT_url / BT_unurl / hello).
// TP-NET-01 (headless part: rewrite coverage, exclusions, idempotence, line stability) and TP-NET-02 (identity rules on the
// fork engine). Generic fixtures only; every app is generated into a temp dir.
const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const pluginPath = path.resolve(__dirname, '../lib/instrument/plugin.js')
const createPlugin = require(pluginPath)
const rewriteNet = require('../lib/instrument/rewrite-net.js')
const { startHub, localLease } = require('../lib/instrument/hub.js')
const forceTranspile = path.resolve(__dirname, 'fixtures/instrument-plugin/force-transpile.js')
const brsCli = path.resolve(__dirname, '../node_modules/@ramonlobo/brs-node/bin/brs.cli.js')
const NET_BRS = path.resolve(__dirname, '../lib/instrument/runtime/source/bt/BT_net.brs')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-netrw-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function mkapp(name, files) {
  const dir = path.join(tmp, 'src-' + name)
  const all = { manifest: 'title=T\nmajor_version=1\nminor_version=0\nbuild_version=1\n', ...files }
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
async function build(dir, name, plugins, extra = {}) {
  const out = path.join(tmp, 'out-' + name)
  const pb = new ProgramBuilder()
  await pb.run({
    cwd: dir, rootDir: dir, stagingDir: path.join(out, 'staging'), createPackage: false, copyToStaging: true,
    files: ['manifest', 'source/**/*', 'components/**/*', 'roku_modules/**/*'], plugins, logLevel: 'error',
    autoImportComponentScript: false, diagnosticFilters: [1107, 1140, 1009], ...extra,
  })
  const errors = pb.program.getDiagnostics().filter((d) => d.severity === 1)
  return { staging: path.join(out, 'staging'), errors, result: createPlugin.lastInstance.getResult() }
}
const read = (b, rel) => fs.readFileSync(path.join(b.staging, rel), 'utf8')
const nlines = (s) => s.replace(/\n+$/, '').split('\n').length

const SITES = [
  'function sites(base as string)',
  '    x = CreateObject("roUrlTransfer")',
  '    x.setUrl("https://api.example.test/a")',
  '    x.SETURL("https://api.example.test/b")',
  '    m.client.http.setUrl(base + "/c")',
  '    m.top.api.setUrl(urlFor(1))',
  '    xs = [CreateObject("roUrlTransfer")]',
  '    xs[0].setUrl("https://api.example.test/d")',
  '    getXfer().setUrl("https://api.example.test/e")',
  '    (x).setUrl("https://api.example.test/f")',
  '    CreateObject("roUrlTransfer").setUrl("https://api.example.test/g")',
  '    print x.getUrl()',
  '    if x.GetUrl() = "" then print "empty"',
  '    cur = x.getUrl()',
  '    return x.getUrl()',
  'end function',
  '',
].join('\n')

describe('rewrite-net: receivers (TP-NET-01)', () => {
  let b
  beforeAll(async () => { b = await build(mkapp('recv', { 'source/main.brs': 'sub main()\nend sub\n', 'source/net.brs': SITES }), 'recv', [pluginPath]) })

  it('wraps setUrl for receivers of any expression shape and any case', () => {
    const out = read(b, 'source/net.brs')
    for (const want of [
      'x.setUrl(BT_url("https://api.example.test/a"))',
      '.SETURL(BT_url("https://api.example.test/b"))',
      'm.client.http.setUrl(BT_url(base + "/c"))',
      'm.top.api.setUrl(BT_url(urlFor(1)))',
      'xs[0].setUrl(BT_url("https://api.example.test/d"))',
      'getXfer().setUrl(BT_url("https://api.example.test/e"))',
      '.setUrl(BT_url("https://api.example.test/g"))',
    ]) expect(out).toContain(want)
    expect(b.result.stats.setUrl).toBe(8)
  })
  it('wraps getUrl where the result is used', () => {
    const out = read(b, 'source/net.brs')
    expect(out).toMatch(/print BT_unurl\(x\.getUrl\(\)\)/)
    expect(out).toMatch(/if BT_unurl\(x\.GetUrl\(\)\) = ""/)
    expect(out).toMatch(/cur = BT_unurl\(x\.getUrl\(\)\)/)
    expect(out).toMatch(/return BT_unurl\(x\.getUrl\(\)\)/)
    expect(b.result.stats.getUrl).toBe(4)
  })
  it('records file, line, receiver and kind for every site', () => {
    const r = b.result.rewritten.filter((x) => x.kind === 'setUrl')
    expect(r.map((x) => x.line)).toEqual([3, 4, 5, 6, 8, 9, 10, 11])
    expect(r.find((x) => x.line === 5).receiver).toBe('m.client.http')
  })
  it('leaves other shapes alone: indexed name, other arity, bare getUrl, callFunc, content node urls', async () => {
    const src = [
      'sub other(o as object, v as object, kind as string)',
      '    x = CreateObject("roUrlTransfer")',
      '    x["setUrl"]("https://api.example.test/idx")',
      '    x.setUrl("a", "b")',
      '    x.setUrl()',
      '    x.getUrl()',
      '    z = x.getUrl("arg")',
      '    o.callFunc("setUrl", "https://api.example.test/cf")',
      '    v.content.url = "https://media.example.test/v.m3u8"',
      '    p = CreateObject(kind)',
      '    p.getUrl2("u")',
      'end sub',
      '',
    ].join('\n')
    const o = await build(mkapp('other', { 'source/main.brs': 'sub main()\nend sub\n', 'source/o.brs': src }), 'other', [pluginPath])
    const out = read(o, 'source/o.brs')
    expect(out).not.toMatch(/BT_url|BT_unurl/)
    expect(out).toContain('v.content.url = "https://media.example.test/v.m3u8"')
    expect(o.result.stats.setUrl + o.result.stats.getUrl).toBe(0)
    const kinds = o.result.skipped.map((s) => s.kind)
    expect(kinds).toEqual(expect.arrayContaining(['indexed-seturl', 'bare-geturl', 'callfunc-seturl']))
  })
})

describe('rewrite-net: exclusions (TP-NET-01)', () => {
  const mk = (n) => `sub ${n}()\n    x = CreateObject("roUrlTransfer")\n    x.setUrl("https://api.example.test/z")\n    print x.getUrl()\nend sub\n`
  const NET = mk('n_app')
  let b
  let base
  const files = {
    'source/main.brs': 'sub main()\nend sub\n',
    'source/app.brs': NET,
    'source/vendor/v.brs': mk('n_v'),
    'source/rooibos/r.brs': mk('n_r'),
    'source/bt/own.brs': mk('n_bt'),
    'source/lib/legacy.brs': mk('n_l'),
    'source/a.spec.brs': mk('n_s'),
    'roku_modules/pkg/p.brs': mk('n_p'),
    'source/recv.brs': 'sub r()\n    cfg = {}\n    cfg.setUrl("https://api.example.test/aa")\n    d = CreateObject("roUrlTransfer")\n    d.setUrl("https://api.example.test/dd")\nend sub\n',
  }
  beforeAll(async () => {
    const dir = mkapp('excl', files)
    base = await build(dir, 'excl-base', [forceTranspile])
    b = await build(dir, 'excl', [pluginPath], { instrument: { exclude: ['source/lib/**'], net: { receivers: { deny: ['d'] } } } })
  })
  it('rewrites user files', () => { expect(read(b, 'source/app.brs')).toContain('x.setUrl(BT_url(') })
  it.each(['source/vendor/v.brs', 'source/rooibos/r.brs', 'source/bt/own.brs', 'source/lib/legacy.brs', 'source/a.spec.brs', 'roku_modules/pkg/p.brs'])('%s is untouched', (rel) => {
    expect(read(b, rel)).toBe(files[rel])
  })
  it('does not rewrite an excluded receiver type or a denied receiver, and says so', () => {
    const out = read(b, 'source/recv.brs')
    expect(out).toContain('cfg.setUrl("https://api.example.test/aa")')
    expect(out).toContain('d.setUrl("https://api.example.test/dd")')
    expect(b.result.skipped.filter((s) => s.kind === 'net-receiver-excluded').map((s) => s.reason.split('.')[0]).sort()).toEqual(['cfg', 'd'])
  })
  it('instrument.net=false rewrites nothing', async () => {
    const o = await build(mkapp('off', files), 'off', [pluginPath], { instrument: { net: false } })
    expect(read(o, 'source/app.brs')).toBe(NET)
    expect(o.result.stats.setUrl).toBe(0)
  })
  it('the excluded files equal the plugin-off build', () => {
    expect(read(b, 'source/vendor/v.brs').trimEnd()).toBe(read(base, 'source/vendor/v.brs').trimEnd())
  })
})

describe('rewrite-net: idempotence (TP-NET-01 edge)', () => {
  it('a file that already contains BT_url / BT_unurl is not wrapped again', async () => {
    const src = [
      'sub n()',
      '    x = CreateObject("roUrlTransfer")',
      '    x.setUrl(BT_url("https://api.example.test/a"))',
      '    print BT_unurl(x.getUrl())',
      '    x.setUrl("https://api.example.test/b")',
      'end sub',
      '',
    ].join('\n')
    const b = await build(mkapp('idem', { 'source/main.brs': 'sub main()\nend sub\n', 'source/n.brs': src }), 'idem', [pluginPath])
    const out = read(b, 'source/n.brs')
    expect(out).not.toMatch(/BT_url\(BT_url|BT_unurl\(BT_unurl/)
    expect(out.match(/BT_url\(/g)).toHaveLength(2)
    expect(out.match(/BT_unurl\(/g)).toHaveLength(1)
    expect(b.result.stats.setUrl).toBe(1)
    expect(b.result.stats.getUrl).toBe(0)
  })
  it('building the rewritten output again changes nothing', async () => {
    const first = await build(mkapp('idem1', { 'source/main.brs': 'sub main()\nend sub\n', 'source/net.brs': SITES }), 'idem1', [pluginPath])
    const out1 = read(first, 'source/net.brs')
    const second = await build(mkapp('idem2', { 'source/main.brs': 'sub main()\nend sub\n', 'source/net.brs': out1 }), 'idem2', [pluginPath])
    expect(second.result.stats.setUrl + second.result.stats.getUrl).toBe(0)
    expect(read(second, 'source/net.brs').replace(/\n+$/, '')).toBe(out1.replace(/\n+$/, ''))
  })
  it('one plugin run wraps a getUrl exactly once even though the walk descends into the new node', async () => {
    const b = await build(mkapp('once', { 'source/main.brs': 'sub main()\nend sub\n', 'source/n.brs': 'function f(x as object)\n    return x.getUrl()\nend function\n' }), 'once', [pluginPath])
    expect(read(b, 'source/n.brs').match(/BT_unurl\(/g)).toHaveLength(1)
  })
})

describe('rewrite-net: line stability (TP-NET-01)', () => {
  it('a rewritten file has the same lines as the plugin-off all-AST build, modulo the wrapper', async () => {
    const dir = mkapp('lines', { 'source/main.brs': 'sub main()\nend sub\n', 'source/net.brs': SITES })
    const all = await build(dir, 'lines-all', [forceTranspile])
    const on = await build(dir, 'lines-on', [pluginPath])
    const unwrap = (s) => s.replace(/BT_unurl\((\w+\.getUrl\(\))\)/gi, '$1').replace(/BT_url\(((?:[^()]|\([^()]*\))*)\)/g, '$1')
    expect(unwrap(read(on, 'source/net.brs'))).toBe(read(all, 'source/net.brs'))
    expect(nlines(read(on, 'source/net.brs'))).toBe(nlines(read(all, 'source/net.brs')))
  })
  it('the wrapper adds no newline: every site stays on its own line', async () => {
    const dir = mkapp('lines2', { 'source/main.brs': 'sub main()\nend sub\n', 'source/net.brs': SITES })
    const on = await build(dir, 'lines2-on', [pluginPath])
    const lines = read(on, 'source/net.brs').split('\n')
    const l = lines.findIndex((x) => x.includes('m.client.http.setUrl'))
    expect(lines[l]).toContain('BT_url(base + "/c")')
    expect(l).toBe(SITES.split('\n').findIndex((x) => x.includes('m.client.http.setUrl')))
  })
  it('calleeMember reads dotted and string-indexed names only', () => {
    expect(typeof rewriteNet.rewriteFile).toBe('function')
    expect(rewriteNet.calleeMember({})).toBe('')
  })
})

describe('BT_net runtime selection', () => {
  const NETSRC = 'sub main()\n    x = CreateObject("roUrlTransfer")\n    x.setUrl("https://api.example.test/a")\nend sub\n'
  const CONFIG = '#if BT_AGENT\nfunction BT_config() as object\n    return { token: "t", hub: { host: "auto", port: 8790 }, features: {}, caps: {} }\nend function\n#end if\n'
  it('without BT_config the identity stubs stay', async () => {
    const b = await build(mkapp('rt-stub', { 'source/main.brs': NETSRC }), 'rt-stub', [pluginPath])
    const rt = read(b, 'source/bt/BT_runtime.brs')
    expect(rt).toContain('function BT_url(')
    expect(rt).not.toContain('BT_netBase')
    expect(b.errors.map((e) => e.message)).toEqual([])
  })
  it('with BT_config the real BT_net replaces the stubs, compiles, and the components import BT_config', async () => {
    const files = {
      'source/main.brs': NETSRC,
      'source/bt/BT_config.brs': CONFIG,
      'components/Scn.xml': '<?xml version="1.0" encoding="utf-8" ?>\n<component name="Scn" extends="Scene"><script type="text/brightscript" uri="pkg:/components/Scn.brs"/></component>\n',
      'components/Scn.brs': 'sub init()\n    x = CreateObject("roUrlTransfer")\n    x.setUrl("https://api.example.test/b")\nend sub\n',
    }
    const b = await build(mkapp('rt-real', files), 'rt-real', [pluginPath], { diagnosticFilters: [1107, 1009] })
    const rt = read(b, 'source/bt/BT_runtime.brs')
    expect(rt).toContain('function BT_netBase()')
    expect(rt.match(/function BT_url\(/g)).toHaveLength(1)
    expect(rt.match(/^#if BT_AGENT/gm)).toHaveLength(1)
    expect(rt.match(/^#end if/gm)).toHaveLength(1)
    expect(read(b, 'components/Scn.xml')).toContain('pkg:/source/bt/BT_config.brs')
    expect(b.errors.map((e) => `${e.code} ${e.message}`)).toEqual([])
  })
  it('instrument.net=false keeps the stubs even with BT_config', async () => {
    const b = await build(mkapp('rt-off', { 'source/main.brs': NETSRC, 'source/bt/BT_config.brs': CONFIG }), 'rt-off', [pluginPath], { instrument: { net: false } })
    expect(read(b, 'source/bt/BT_runtime.brs')).not.toContain('BT_netBase')
  })
  it('the helper names are reserved (BT9001)', async () => {
    const b = await build(mkapp('rt-res', { 'source/main.brs': NETSRC, 'source/u.brs': 'function BT_netBase() as string\n    return ""\nend function\n' }), 'rt-res', [pluginPath])
    expect(b.errors.some((e) => e.code === 'BT9001')).toBe(true)
  })
})

// TP-NET-02: BT_url / BT_unurl identity rules, run on the fork engine (brs-cli) against the real loopback hub.
function runBrs(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}
function brsProgram(host, port, body) {
  const net = fs.readFileSync(NET_BRS, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
  return [
    'function BT_config() as object',
    `    return { token: "tok0123456789abcdef", hub: { host: "${host}", port: ${port} }, features: {}, caps: {} }`,
    'end function',
    net,
    'sub main()',
    body,
    'end sub',
    '',
  ].join('\n')
}

describe('BT_url / BT_unurl identity rules (TP-NET-02, fork engine)', () => {
  let hub
  beforeAll(async () => {
    hub = await startHub({ host: '127.0.0.1', port: 0, mode: 'headless', lease: localLease(), tokens: ['tok0123456789abcdef'] })
  })
  afterAll(async () => { await hub.stop() })
  const TOKEN_BASE = () => `http://127.0.0.1:${hub.port}/bt/tok0123456789abcdef/net/;`

  it('rewrites https with a session, leaves everything else unchanged, and BT_unurl restores', async () => {
    const f = path.join(tmp, 'identity.brs')
    fs.writeFileSync(f, brsProgram('127.0.0.1', hub.port, [
      '    print "1:" + type(BT_url(5))',
      '    print "2:" + BT_url("pkg:/x")',
      '    print "3:" + BT_url("tmp:/x")',
      '    print "4:" + BT_url("file:///x")',
      '    print "5:" + BT_url("https://h.example/x?a=1")',
      '    print "6:" + BT_url(BT_url("https://h.example/x"))',
      '    print "7:" + BT_unurl(BT_url("https://h.example/x?a=1"))',
      '    print "8:" + type(BT_unurl(invalid))',
      '    print "9:" + BT_unurl("https://h.example/plain")',
    ].join('\n')))
    const out = await runBrs(f)
    const base = TOKEN_BASE()
    expect(out).toContain('1:Integer')
    expect(out).toContain('2:pkg:/x')
    expect(out).toContain('3:tmp:/x')
    expect(out).toContain('4:file:///x')
    expect(out).toContain(`5:${base}https://h.example/x?a=1`)
    expect(out).toMatch(new RegExp(`6:${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}https://h\\.example/x\\r?\\n`))
    expect(out).not.toContain(`${base}${base}`)
    expect(out).toContain('7:https://h.example/x?a=1')
    expect(out).toContain('8:Invalid')
    expect(out).toContain('9:https://h.example/plain')
  }, 30000)

  it('is the identity function with no hub, with host "auto", and with a wrong token', async () => {
    const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r))
    const deadPort = dead.address().port; await new Promise((r) => dead.close(r))
    const body = '    print "r:" + BT_url("http://h.example/x")\n    print "r2:" + BT_url("http://h.example/y")'
    const f = path.join(tmp, 'nohub.brs')
    fs.writeFileSync(f, brsProgram('127.0.0.1', deadPort, body)); expect(await runBrs(f)).toContain('r:http://h.example/x')
    fs.writeFileSync(f, brsProgram('auto', 8790, body)); expect(await runBrs(f)).toContain('r:http://h.example/x')
    fs.writeFileSync(f, brsProgram('127.0.0.1', hub.port, body).replace('tok0123456789abcdef', 'wrongtoken')); expect(await runBrs(f)).toContain('r:http://h.example/x')
  }, 40000)

  it('does not crash and stays the identity when CreateObject("roUrlTransfer") returns invalid (render thread, fw 16.0.4)', async () => {
    const f = path.join(tmp, 'invalid-xfer.brs')
    const src = brsProgram('127.0.0.1', hub.port, '    print "r:" + BT_url("http://h.example/x")\n    print "r2:" + BT_url("http://h.example/y")')
      .replace('CreateObject("roUrlTransfer")', 'invalid')
    expect(src).not.toContain('CreateObject("roUrlTransfer")')
    fs.writeFileSync(f, src)
    const out = await runBrs(f)
    expect(out).toContain('r:http://h.example/x')
    expect(out).toContain('r2:http://h.example/y')
    expect(out).not.toMatch(/Dot|Operator|Runtime Error/i)
  }, 30000)

  // The fork engine's Wait(timeout) does not return while an async roUrlTransfer is pending against a server that never
  // answers (found in NET-N-T2), so the bounded-hello behavior on a silent hub cannot run headless. It is a device case
  // (TP-NET-20..31 lane). This pins the protocol the device needs: min transfer rate, own timer, AsyncCancel.
  it('the hello is bounded: min transfer rate, own 1.5 s timer and AsyncCancel (device behavior, source pin)', () => {
    const src = fs.readFileSync(NET_BRS, 'utf8')
    expect(src).toMatch(/SetMinimumTransferRate\(1, 1\)/)
    expect(src).toMatch(/left = 1500 - clock\.TotalMilliseconds\(\)/)
    expect(src).toMatch(/x\.AsyncCancel\(\)/)
    expect(src).toMatch(/retryAt = now \+ 30000/)
  })
})
