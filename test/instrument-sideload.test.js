import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { sideload, installPackage, parseInstallerReply } = require('../lib/instrument/sideload')
const { fakeInstaller, toLocal } = require('./fixtures/fake-installer')

const PW = 'sekrit-pw'
let tmp, zip
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-side-')); zip = path.join(tmp, 'app.zip'); fs.writeFileSync(zip, 'PK') })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const challenge = 'Digest realm="rokudev", nonce="abc", qop="auth"'
// Stub installer: replies is a list of {status, html} consumed per logical request (a 401 challenge is added when `auth`).
function stub(replies, { auth = true, wrongPw = false, active = '<active-app><app id="dev" type="appl" version="1.0.0">Sample</app></active-app>' } = {}) {
  const calls = []
  const ecp = { n: 0 }
  const launches = []
  const f = async (url, init) => {
    if (/:8060\/launch\/dev$/.test(url)) { launches.push(init && init.method); return { status: 200, headers: { get: () => null }, text: async () => '' } }
    if (/:8060\/query\/active-app$/.test(url)) {
      ecp.n++
      const body = typeof active === 'function' ? active(ecp.n) : active
      return { status: 200, headers: { get: () => null }, text: async () => body }
    }
    const hasAuth = !!(init.headers && init.headers.Authorization)
    if (auth && !hasAuth) return { status: 401, headers: { get: () => challenge }, text: async () => '' }
    if (hasAuth && wrongPw) return { status: 401, headers: { get: () => challenge }, text: async () => '' }
    const mysubmit = /name="mysubmit"\r\n\r\n(\w+)/.exec(Buffer.from(init.body).toString('utf8'))[1]
    calls.push(mysubmit)
    const r = replies.shift()
    return { status: r.status || 200, headers: { get: () => null }, text: async () => r.html }
  }
  return { f, calls, ecp, launches }
}
const mkLease = () => { const l = { released: 0, release() { l.released++ } }; return l }
function run(replies, o = {}, stubOpts) {
  const s = stub(replies, stubOpts)
  const lease = mkLease(); const lines = []
  const deps = {
    fetch: s.f, log: (l) => lines.push(l),
    tcpProbe: async () => o.tcpOpen !== false,
    sleep: async () => {}, activeTries: 3,
    acquireForLane: async (a) => { lines.acquire = a; return o.leaseCode ? { code: o.leaseCode } : { lease } },
  }
  const p = sideload({ rootDir: tmp }, { zip, host: '192.0.2.5', password: PW, ...o.opts }, deps)
  return p.then((code) => ({ code, lines, calls: s.calls, launches: s.launches, ecp: s.ecp.n, lease }))
}

describe('parseInstallerReply', () => {
  it('classifies replies', () => {
    expect(parseInstallerReply(200, '<font>Install Success.</font>').ok).toBe(true)
    expect(parseInstallerReply(200, 'Identical to previous version -- not replacing.')).toEqual({ ok: true, identical: true })
    expect(parseInstallerReply(200, 'Install Success')).toEqual({ ok: true })
    expect(parseInstallerReply(401, '')).toMatchObject({ ok: false, kind: 'auth' })
    expect(parseInstallerReply(200, '<font color="red">Install Failure: Compilation Failed.</font>')).toMatchObject({ kind: 'install', message: 'Compilation Failed.' })
    expect(parseInstallerReply(500, 'x')).toMatchObject({ kind: 'http' })
    expect(parseInstallerReply(200, 'hello')).toMatchObject({ kind: 'install' })
  })
})

describe('instrument sideload (stub installer)', () => {
  it('success: exit 0, one install, lease taken without bypass and released', async () => {
    const r = await run([{ html: 'Install Success' }])
    expect(r.code).toBe(0)
    expect(r.calls).toEqual(['Replace'])
    expect(r.lease.released).toBe(1)
    expect(r.lines.acquire).toMatchObject({ host: '192.0.2.5', allowBypass: false })
  })
  it('verifies the dev channel is active after the install (under the lease)', async () => {
    const r = await run([{ html: 'Install Success' }])
    expect(r.code).toBe(0)
    expect(r.ecp).toBe(1)
    expect(r.lines.join('\n')).toMatch(/dev channel active/)
  })
  it('channel not active (Home in front): exit 1 with the fix text, password not printed', async () => {
    const r = await run([{ html: 'Install Success' }], {}, { active: '<active-app><app>Roku</app></active-app>' })
    expect(r.code).toBe(1)
    expect(r.ecp).toBe(3)
    const out = r.lines.join('\n')
    expect(out).toMatch(/dev channel is not active/)
    expect(out).toMatch(/source\/main\.brs/)
    expect(out).not.toContain(PW)
    expect(r.lease.released).toBe(1)
  })
  it('channel becomes active on a later poll: exit 0', async () => {
    const dev = '<active-app><app id="dev">Sample</app></active-app>'
    const r = await run([{ html: 'Install Success' }], {}, { active: (n) => (n < 2 ? '<active-app><app>Roku</app></active-app>' : dev) })
    expect(r.code).toBe(0)
    expect(r.ecp).toBe(2)
  })
  it('identical package: relaunches dev once, then verifies active', async () => {
    const r = await run([{ html: 'Identical to previous version -- not replacing.' }])
    expect(r.code).toBe(0)
    expect(r.calls).toEqual(['Replace'])
    expect(r.launches).toEqual(['POST'])
    expect(r.lines.join('\n')).toMatch(/identical package already installed; relaunched the dev channel/)
  })
  it('identical package but never active: exit 1 with the relaunch message, one launch, no secrets', async () => {
    const r = await run([{ html: 'Identical to previous version' }], {}, { active: '<active-app><app>Roku</app></active-app>' })
    expect(r.code).toBe(1)
    expect(r.launches).toHaveLength(1)
    expect(r.ecp).toBe(3)
    const out = r.lines.join('\n')
    expect(out).toMatch(/identical package is installed but the dev channel did not start after a relaunch/)
    expect(out).not.toMatch(/likely exited at launch/)
    expect(out).not.toContain(PW)
  })
  it('normal success and failure send no launch request', async () => {
    const ok = await run([{ html: 'Install Success' }])
    expect(ok.code).toBe(0)
    expect(ok.launches).toEqual([])
    expect(ok.lines.join('\n')).toMatch(/installed .* dev channel active/)
    const bad = await run([{ html: 'Install Failure: Compilation Failed.' }, {}, { html: 'Install Failure: Compilation Failed.' }])
    expect(bad.code).toBe(1)
    expect(bad.launches).toEqual([])
  })
  it('auth failure: exit 1, no retry, password not printed', async () => {
    const r = await run([{ html: 'x' }], {}, { wrongPw: true })
    expect(r.code).toBe(1)
    expect(r.calls).toEqual([])
    expect(r.lines.join('\n')).toMatch(/authentication failed/)
    expect(r.lines.join('\n')).not.toContain(PW)
    expect(r.lease.released).toBe(1)
  })
  it('TCP 80 closed: exit 1 before any request', async () => {
    const r = await run([], { tcpOpen: false })
    expect(r.code).toBe(1)
    expect(r.calls).toEqual([])
    expect(r.lines.join('\n')).toMatch(/not reachable/)
    expect(r.lease.released).toBe(1)
  })
  it('install error parsing: reports the installer message, exit 1', async () => {
    const r = await run([{ html: 'Install Failure: Compilation Failed.' }, { html: '' }, { html: 'Install Failure: Compilation Failed.' }])
    expect(r.code).toBe(1)
    expect(r.lines.join('\n')).toMatch(/install failed: Compilation Failed/)
  })
  it('retries once after Delete, then succeeds', async () => {
    const r = await run([{ html: 'Install Failure: Device busy' }, { html: 'Delete done' }, { html: 'Install Success' }])
    expect(r.code).toBe(0)
    expect(r.calls).toEqual(['Replace', 'Delete', 'Replace'])
  })
  it('retries only once: a second failure ends in exit 1 after exactly Replace, Delete, Replace', async () => {
    const f = { html: 'Install Failure: nope' }
    const r = await run([f, { html: '' }, f, f])
    expect(r.code).toBe(1)
    expect(r.calls).toEqual(['Replace', 'Delete', 'Replace'])
  })
  it('lease failure code is returned and nothing is sent', async () => {
    const r = await run([], { leaseCode: 75 })
    expect(r.code).toBe(75)
    expect(r.calls).toEqual([])
  })
  it('usage: needs host and password', async () => {
    expect((await run([], { opts: { host: null } })).code).toBe(2)
    expect((await run([], { opts: { password: null } })).code).toBe(2)
  })
})

async function runReal(srvOpts) {
  const f = await fakeInstaller(srvOpts)
  const lines = []
  const big = path.join(tmp, 'big.zip'); fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 1))
  const code = await sideload({ rootDir: tmp }, { zip: big, host: '192.0.2.5', password: PW }, {
    fetch: toLocal(f.port), log: (l) => lines.push(l), tcpProbe: async () => true, sleep: async () => {}, activeTries: 2,
    acquireForLane: async () => ({ lease: mkLease() }),
  })
  await new Promise((r) => f.srv.close(r))
  return { code, lines, log: f.log }
}

describe('instrument sideload (local installer that closes the socket after the 401)', () => {
  it('installs without EPIPE and uploads the archive once, only when authenticated', async () => {
    const r = await runReal()
    expect(r.code).toBe(0)
    expect(r.log.reqs.map((x) => x.authed)).toEqual([false, true])
    expect(r.log.bytesBeforeAuth).toBe(0)
    expect(r.log.reqs[1].bytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(r.log.sockets[0]).not.toBe(r.log.sockets[1])
  })
  it('first authenticated POST fails, then Delete and a second install succeed', async () => {
    const r = await runReal({ failAuthPostsBy: [1] })
    expect(r.code).toBe(0)
    expect(r.log.reqs.filter((x) => x.authed).map((x) => x.submit).filter(Boolean)).toContain('Delete')
    const out = r.lines.join('\n')
    expect(out).toMatch(/install failed \(POST \/plugin_install \(authenticated\) failed: /)
    expect(out).not.toContain(PW)
  })
  it('persistent failure: exit 1 names the failing step and code, no password or URL', async () => {
    const r = await runReal({ failAuthPostsBy: [1, 2, 3] })
    expect(r.code).toBe(1)
    const out = r.lines.join('\n')
    expect(out).toMatch(/installer request failed: POST \/plugin_install \(authenticated\) failed: \w+/)
    expect(out).not.toContain(PW)
    expect(out).not.toMatch(/http:\/\//)
  })
})

describe('installPackage (lease-free core, never throws)', () => {
  const zipData = Buffer.from('PK')
  const core = (replies, o = {}, stubOpts) => {
    const s = stub(replies, stubOpts)
    const steps = []
    const p = installPackage({
      host: '192.0.2.5', password: PW, zipData, fetchFn: s.f, tcpProbe: async () => o.tcpOpen !== false,
      sleep: async () => {}, activeTries: 2, onStep: (e) => steps.push(e.step), ...o.args,
    })
    return p.then((r) => ({ r, steps, calls: s.calls, launches: s.launches }))
  }
  it('OK: result shape, steps in order, no password', async () => {
    const { r, steps } = await core([{ html: 'Install Success' }])
    expect(r).toMatchObject({ ok: true, code: 'OK', active: true, identical: false, retried: false })
    expect(r.app).toMatchObject({ id: 'dev' })
    expect(Number.isFinite(r.durationMs)).toBe(true)
    expect(steps).toEqual(['probe', 'upload', 'verify-active'])
    expect(JSON.stringify(r)).not.toContain(PW)
  })
  it('OK identical: relaunches dev, identical flag set', async () => {
    const { r, launches } = await core([{ html: 'Identical to previous version' }])
    expect(r).toMatchObject({ ok: true, code: 'OK', identical: true })
    expect(launches).toEqual(['POST'])
  })
  it('UNREACHABLE: nothing is sent', async () => {
    const { r, calls } = await core([], { tcpOpen: false })
    expect(r).toMatchObject({ ok: false, code: 'UNREACHABLE', step: 'probe' })
    expect(calls).toEqual([])
  })
  it('AUTH: no retry', async () => {
    const { r, calls } = await core([{ html: 'x' }], {}, { wrongPw: true })
    expect(r).toMatchObject({ ok: false, code: 'AUTH', retried: false })
    expect(calls).toEqual([])
    expect(JSON.stringify(r)).not.toContain(PW)
  })
  it('INSTALL_FAILED after one Delete and retry', async () => {
    const f = { html: 'Install Failure: Compilation Failed.' }
    const { r, calls, steps } = await core([f, { html: '' }, f])
    expect(r).toMatchObject({ ok: false, code: 'INSTALL_FAILED', retried: true, message: 'Compilation Failed.' })
    expect(calls).toEqual(['Replace', 'Delete', 'Replace'])
    expect(steps).toContain('delete-retry')
  })
  it('NETWORK carries the errno as cause and never the password', async () => {
    const f = async () => { throw Object.assign(new Error(`boom ${PW}`), { cause: { code: 'EPIPE' } }) }
    const { r } = await core([], { args: { fetchFn: f } })
    expect(r).toMatchObject({ ok: false, code: 'NETWORK', cause: 'EPIPE', retried: true })
    expect(JSON.stringify(r)).not.toContain(PW)
  })
  it('NOT_ACTIVE when the dev channel never comes up', async () => {
    const { r } = await core([{ html: 'Install Success' }], {}, { active: '<active-app><app>Roku</app></active-app>' })
    expect(r).toMatchObject({ ok: false, code: 'NOT_ACTIVE', step: 'verify-active', active: false })
    expect(r.message).toMatch(/dev channel is not active/)
  })
  it('CANCELLED when the signal is already aborted: nothing is sent', async () => {
    const ac = new AbortController(); ac.abort()
    const { r, calls } = await core([{ html: 'Install Success' }], { args: { signal: ac.signal } })
    expect(r).toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(calls).toEqual([])
  })
  it('CANCELLED when aborted during the upload', async () => {
    const ac = new AbortController()
    const f = (url, init) => new Promise((_res, rej) => {
      ac.abort()
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      if (init.signal.aborted) rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
    const { r } = await core([], { args: { fetchFn: f, signal: ac.signal } })
    expect(r).toMatchObject({ ok: false, code: 'CANCELLED' })
  })
  it('LEASE_LOST when the lease check fails mid-install', async () => {
    let n = 0
    const { r, calls } = await core([{ html: 'Install Success' }], { args: { leaseCheck: () => ++n < 3 } })
    expect(r).toMatchObject({ ok: false, code: 'LEASE_LOST', step: 'verify-active' })
    expect(calls).toEqual(['Replace'])
  })
  it('bad input and a throwing onStep do not throw', async () => {
    expect((await installPackage({})).code).toBe('INSTALL_FAILED')
    const { r } = await core([{ html: 'Install Success' }], { args: { onStep: () => { throw new Error('x') } } })
    expect(r.code).toBe('OK')
  })
  it('sideload maps a lost lease to exit 77', async () => {
    const s = stub([{ html: 'Install Success' }])
    const lease = { lost: true, release() {} }
    const code = await sideload({ rootDir: tmp }, { zip, host: '192.0.2.5', password: PW }, {
      fetch: s.f, log: () => {}, tcpProbe: async () => true, sleep: async () => {}, activeTries: 1, acquireForLane: async () => ({ lease }),
    })
    expect(code).toBe(77)
  })
})
