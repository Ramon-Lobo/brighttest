import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { sideload, parseInstallerReply } = require('../lib/instrument/sideload')

const PW = 'sekrit-pw'
let tmp, zip
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-side-')); zip = path.join(tmp, 'app.zip'); fs.writeFileSync(zip, 'PK') })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const challenge = 'Digest realm="rokudev", nonce="abc", qop="auth"'
// Stub installer: replies is a list of {status, html} consumed per logical request (a 401 challenge is added when `auth`).
function stub(replies, { auth = true, wrongPw = false, active = '<active-app><app id="dev" type="appl" version="1.0.0">Sample</app></active-app>' } = {}) {
  const calls = []
  const ecp = { n: 0 }
  const f = async (url, init) => {
    if (/:8060\/query\/active-app$/.test(url)) {
      ecp.n++
      const body = typeof active === 'function' ? active(ecp.n) : active
      return { status: 200, headers: { get: () => null }, text: async () => body }
    }
    const hasAuth = !!(init.headers && init.headers.Authorization)
    const mysubmit = /name="mysubmit"\r\n\r\n(\w+)/.exec(Buffer.from(init.body).toString('utf8'))[1]
    if (auth && !hasAuth) return { status: 401, headers: { get: () => challenge }, text: async () => '' }
    if (hasAuth && wrongPw) return { status: 401, headers: { get: () => challenge }, text: async () => '' }
    calls.push(mysubmit)
    const r = replies.shift()
    return { status: r.status || 200, headers: { get: () => null }, text: async () => r.html }
  }
  return { f, calls, ecp }
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
  return p.then((code) => ({ code, lines, calls: s.calls, ecp: s.ecp.n, lease }))
}

describe('parseInstallerReply', () => {
  it('classifies replies', () => {
    expect(parseInstallerReply(200, '<font>Install Success.</font>').ok).toBe(true)
    expect(parseInstallerReply(200, 'Identical to previous version -- not replacing.').ok).toBe(true)
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
