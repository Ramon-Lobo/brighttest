import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const studio = require('../lib/studio/server.js')
const lease = require('../lib/device-lease.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const { makeZip, plainEntries, instrumentedEntries } = require('./support/zipgen')

// STUDIO-BUILDS-T3: the /api/builds routes against a temp store, the fake Roku and a scripted installer. No device.
const PASSWORD = 'pw-sentinel-9f3a' // fake dev password: must never appear in any output
const STUDIO_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' // fake hub token of Studio
const PKG_TOKEN = '0123456789abcdef0123456789abcdef' // the token baked into instrumentedEntries()
let dir, fake, server, port, saved, installs, gateway, seen

const raw = (method, p, { headers = {}, body, ct } = {}) => new Promise((resolve, reject) => {
  const h = { ...headers }
  if (ct) h['Content-Type'] = ct
  else if (method !== 'GET') h['Content-Type'] = 'application/json'
  if (body !== undefined && !h['Transfer-Encoding']) h['Content-Length'] = Buffer.byteLength(body)
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
      const buf = Buffer.concat(chunks)
      const text = buf.toString('utf8')
      seen.push(text)
      let json = null
      try { json = JSON.parse(text) } catch { /* not json */ }
      resolve({ status: res.statusCode, headers: res.headers, buf, text, json })
    })
  })
  r.on('error', reject)
  if (body !== undefined) r.write(body)
  r.end()
})
const api = (m, p, obj) => raw(m, p, { body: obj === undefined ? (m === 'GET' ? undefined : '{}') : JSON.stringify(obj) })
const upload = (zip, extra = {}) => raw('POST', '/api/builds', { ct: 'application/zip', body: zip, ...extra, headers: { 'X-Build-Filename': 'My%20App.zip', ...(extra.headers || {}) } })
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)) } }

// SSE client: collects events; `done` resolves when the server ends the stream.
function openJob(jobId) {
  const out = { events: [], status: null }
  out.done = new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: `/api/builds/jobs/${jobId}` }, (res) => {
      out.status = res.statusCode
      let buf = ''
      res.on('data', (c) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          seen.push(chunk)
          if (chunk.startsWith('data: ')) out.events.push(JSON.parse(chunk.slice(6)))
        }
      })
      res.on('end', resolve); res.on('error', resolve)
    })
    r.on('error', resolve)
    out.abort = () => r.destroy()
  })
  return out
}

// Scripted installer: records each call; `gate` makes it wait until released or aborted.
function fakeInstall(o) {
  const call = { host: o.host, bytes: o.zipData.length }
  installs.push(call)
  return new Promise((resolve) => {
    const result = (code, message, extra = {}) => ({ ok: code === 'OK', code, step: call.step || 'verify-active', message: `${message} (${PASSWORD})`, active: code === 'OK', identical: false, durationMs: 5, retried: false, ...extra })
    o.onStep({ step: 'probe', at: new Date().toISOString() })
    if (gateway.mode === 'fail') return resolve(result('AUTH', 'device rejected the dev password (HTTP 401)', { step: 'upload' }))
    if (gateway.mode === 'retry') o.onStep({ step: 'delete-retry', at: new Date().toISOString(), message: `boom ${PASSWORD}` })
    if (!gateway.hold) { o.onStep({ step: 'upload', at: new Date().toISOString() }); return resolve(result('OK', 'installed; dev channel active')) }
    const step = gateway.holdStep || 'probe'
    call.step = step
    if (step === 'upload') o.onStep({ step: 'upload', at: new Date().toISOString() })
    const onAbort = () => resolve(result('CANCELLED', 'cancelled', { step }))
    if (o.signal.aborted) return onAbort()
    o.signal.addEventListener('abort', onAbort, { once: true })
    gateway.release = () => resolve(result('OK', 'installed; dev channel active'))
  })
}

async function start(extra = {}) {
  server = await studio.start({
    host: '127.0.0.1', password: PASSWORD, port: 0, rootDir: dir, ...extra,
    cfg: { builds: { dir: path.join(dir, 'store'), maxZipMB: 1 } },
    leaseOpts: { acquireOpts: { dir: path.join(dir, 'lease'), timers: false, identity: {} }, tickMs: 20 },
    buildsOpts: { installPackage: fakeInstall, collectFacts: async ({ zipData }) => ({ sha256: require('node:crypto').createHash('sha256').update(zipData).digest('hex'), size: zipData.length, manifest: { title: 'Sample App', version: '1.4.118' }, git: {} }), jobKeepMs: 60000 },
  })
  port = server.address().port
}

beforeEach(async () => {
  seen = []; installs = []; gateway = { mode: 'ok', hold: false }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-builds-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  saved = { ecp: process.env.ROKU_ECP_PORT, lease: process.env.BRIGHTTEST_LEASE_DIR, cache: process.env.BRIGHTTEST_CACHE, tok: process.env.BRIGHTTEST_HUB_TOKEN }
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = path.join(dir, 'lease')
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  process.env.BRIGHTTEST_HUB_TOKEN = STUDIO_TOKEN
})
afterEach(async () => {
  if (gateway.release) gateway.release()
  server.close(); await fake.stop()
  for (const [k, v] of [['ROKU_ECP_PORT', saved.ecp], ['BRIGHTTEST_LEASE_DIR', saved.lease], ['BRIGHTTEST_CACHE', saved.cache], ['BRIGHTTEST_HUB_TOKEN', saved.tok]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const plain = (extra) => makeZip(plainEntries(extra))
const addBuild = async (zip = plain()) => (await upload(zip)).json.build

describe('list, get, upload, edit, delete, download', () => {
  it('lists an empty store with its caps', async () => {
    await start()
    const r = await api('GET', '/api/builds')
    expect(r.status).toBe(200)
    expect(r.json.builds).toEqual([])
    expect(r.json.store).toMatchObject({ count: 0, totalBytes: 0, caps: { maxZipMB: 1 } })
    expect(r.json.warnings).toEqual([])
  })
  it('upload 201 then dedupe 200; label query; get; unknown id 404', async () => {
    await start()
    const zip = plain()
    const a = await raw('POST', '/api/builds?label=Nightly', { ct: 'application/zip', body: zip, headers: { 'X-Build-Filename': 'My%20App.zip' } })
    expect(a.status).toBe(201)
    expect(a.json).toMatchObject({ created: true, build: { label: 'Nightly', filename: 'My App.zip', kind: 'store', installing: false } })
    const b = await upload(zip)
    expect(b.status).toBe(200)
    expect(b.json).toMatchObject({ created: false, deduped: true, build: { id: a.json.build.id } })
    expect((await api('GET', '/api/builds')).json.store.count).toBe(1)
    expect((await api('GET', `/api/builds/${a.json.build.id}`)).json.id).toBe(a.json.build.id)
    const miss = await api('GET', '/api/builds/b000000000000')
    expect(miss.status).toBe(404); expect(miss.json.code).toBe('BUILD_NOT_FOUND')
    expect((await api('GET', '/api/builds/zz')).status).toBe(404)
  })
  it('upload stores the ?filename= query name; the query wins over the header', async () => {
    await start()
    const a = await raw('POST', '/api/builds?filename=some-app.zip', { ct: 'application/zip', body: plain() })
    expect(a.status).toBe(201)
    expect(a.json.build.filename).toBe('some-app.zip')
    const b = await raw('POST', '/api/builds?filename=other%20app.zip', { ct: 'application/zip', body: plain([{ name: 'source/x.brs', data: 'x' }]), headers: { 'X-Build-Filename': 'hdr.zip' } })
    expect(b.json.build.filename).toBe('other app.zip')
  })
  it('upload accepts application/octet-stream too', async () => {
    await start()
    expect((await raw('POST', '/api/builds', { ct: 'application/octet-stream', body: plain() })).status).toBe(201)
  })
  it.each([
    ['not a zip', () => Buffer.from('this is not a zip file at all'), 422, 'BUILD_INVALID_ZIP'],
    ['no manifest', () => makeZip([{ name: 'source/main.brs', data: 'x' }]), 422, 'BUILD_NO_MANIFEST'],
    ['unsafe name', () => makeZip([{ name: 'manifest', data: 'title=x\n' }, { name: '../evil.brs', data: 'x' }]), 422, 'BUILD_UNSAFE_ZIP'],
  ])('refuses %s', async (_n, mk, status, code) => {
    await start()
    const r = await upload(mk())
    expect(r.status).toBe(status); expect(r.json.code).toBe(code)
    expect((await api('GET', '/api/builds')).json.store.count).toBe(0)
  })
  it('413 when Content-Length is over the cap, and when a chunked body streams past it', async () => {
    await start()
    const big = Buffer.alloc(2 * 1024 * 1024, 1)
    // the server answers 413 and closes: the client may see the reset before or after the answer
    const a = await upload(big).catch((e) => ({ status: null, err: e.code }))
    expect([413, null]).toContain(a.status)
    if (a.status) expect(a.json.code).toBe('BUILD_TOO_LARGE'); else expect(['EPIPE', 'ECONNRESET']).toContain(a.err)
    const chunked = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/builds', headers: { 'Content-Type': 'application/zip', 'Transfer-Encoding': 'chunked' } }, (res) => {
        let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); res.on('error', () => resolve({ status: res.statusCode, text: t }))
      })
      r.on('error', () => resolve({ status: null }))
      for (let i = 0; i < 6; i++) r.write(Buffer.alloc(400 * 1024, 2))
      r.end()
    })
    expect([413, null]).toContain(chunked.status)
    if (chunked.status) expect(JSON.parse(chunked.text).code).toBe('BUILD_TOO_LARGE')
    expect((await api('GET', '/api/builds')).json.store.count).toBe(0)
  })
  it('PATCH edits notes, tags, pin, label; bad field 400; unknown key 400; bad json 400; unknown id 404', async () => {
    await start()
    const b = await addBuild()
    const ok = await api('PATCH', `/api/builds/${b.id}`, { notes: 'hello', tags: ['qa'], pinned: true, label: 'Renamed' })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ notes: 'hello', tags: ['qa'], pinned: true, label: 'Renamed' })
    const bad = await api('PATCH', `/api/builds/${b.id}`, { tags: ['BAD TAG'] })
    expect(bad.status).toBe(400); expect(bad.json.code).toBe('BAD_FIELD')
    expect((await api('PATCH', `/api/builds/${b.id}`, { sha256: 'x' })).json.code).toBe('BAD_FIELD')
    expect((await raw('PATCH', `/api/builds/${b.id}`, { body: '{nope' })).json.code).toBe('BAD_REQUEST')
    expect((await api('PATCH', '/api/builds/b000000000000', { notes: 'x' })).status).toBe(404)
  })
  it('DELETE: pinned 409 without force, force removes, unknown 404', async () => {
    await start()
    const b = await addBuild()
    await api('PATCH', `/api/builds/${b.id}`, { pinned: true })
    const p = await api('DELETE', `/api/builds/${b.id}`, {})
    expect(p.status).toBe(409); expect(p.json.code).toBe('BUILD_PINNED')
    const f = await api('DELETE', `/api/builds/${b.id}`, { force: true })
    expect(f.status).toBe(200); expect(f.json).toMatchObject({ ok: true, removed: true })
    expect((await api('GET', `/api/builds/${b.id}`)).status).toBe(404)
    expect((await api('DELETE', `/api/builds/${b.id}`, {})).status).toBe(404)
  })
  it('download returns the zip bytes; 410 when the blob is gone; 409 when corrupt', async () => {
    await start()
    const zip = plain()
    const b = await addBuild(zip)
    const d = await api('GET', `/api/builds/${b.id}/download`)
    expect(d.status).toBe(200)
    expect(d.headers['content-type']).toBe('application/zip')
    expect(d.headers['content-disposition']).toContain("filename*=UTF-8''My%20App.zip")
    expect(Buffer.compare(d.buf, zip)).toBe(0)
    const blob = path.join(dir, 'store', 'blobs', `${b.sha256}.zip`)
    fs.writeFileSync(blob, Buffer.concat([zip, Buffer.from('x')]))
    const c = await api('GET', `/api/builds/${b.id}/download`)
    expect(c.status).toBe(409); expect(c.json.code).toBe('BUILD_BLOB_CORRUPT')
    fs.rmSync(blob)
    const m = await api('GET', `/api/builds/${b.id}/download`)
    expect(m.status).toBe(410); expect(m.json.code).toBe('BUILD_BLOB_MISSING')
  })
  it('405 on a wrong method and 404 on an unknown path', async () => {
    await start()
    expect((await api('PUT', '/api/builds')).status).toBe(405)
    expect((await api('POST', '/api/builds/current', {})).status).toBe(405)
    expect((await api('GET', '/api/builds/jobs/x/y/z')).status).toBe(404)
  })
})

describe('guard', () => {
  it('cross-origin upload 403, text/plain 415, zip content type only on exactly POST /api/builds', async () => {
    await start()
    const zip = plain()
    const x = await raw('POST', '/api/builds', { ct: 'application/zip', body: zip, headers: { Origin: 'https://evil.example' } })
    expect(x.status).toBe(403)
    expect((await raw('POST', '/api/builds', { ct: 'text/plain', body: zip })).status).toBe(415)
    const b = await addBuild()
    for (const [m, p] of [['PATCH', `/api/builds/${b.id}`], ['DELETE', `/api/builds/${b.id}`], ['POST', `/api/builds/${b.id}/install`], ['POST', '/api/builds/jobs/x/cancel'], ['POST', '/api/flow'], ['POST', '/api/builds/other']]) {
      expect((await raw(m, p, { ct: 'application/zip', body: '{}' })).status, `${m} ${p}`).toBe(415)
      expect((await raw(m, p, { ct: 'application/octet-stream', body: '{}' })).status, `${m} ${p}`).toBe(415)
    }
    expect((await api('GET', '/api/builds')).json.store.count).toBe(1)
    expect((await raw('GET', '/api/builds', { headers: { Host: 'rebind.example' } })).status).toBe(403)
  })
})

describe('install job', () => {
  it('202 with jobId and tokenCheck, streams step then done, replays on re-attach, records the install', async () => {
    await start()
    const b = await addBuild()
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(r.status).toBe(202)
    expect(r.json.tokenCheck).toBe('not-instrumented')
    const ev = openJob(r.json.jobId)
    await ev.done
    expect(ev.status).toBe(200)
    expect(ev.events.map((e) => e.type)).toEqual(['step', 'step', 'done'])
    expect(ev.events[2]).toMatchObject({ ok: true, result: { code: 'OK', buildId: b.id } })
    expect(installs).toHaveLength(1)
    const again = openJob(r.json.jobId) // replay of a finished job
    await again.done
    expect(again.events).toEqual(ev.events)
    const rec = (await api('GET', `/api/builds/${b.id}`)).json
    expect(rec).toMatchObject({ installCount: 1, lastInstall: { ok: true }, installs: [{ via: 'studio', ok: true }] })
    expect((await api('GET', '/api/builds/jobs/nope')).status).toBe(404)
  })
  it('a failed install ends with ok:false and is recorded; retry log line is emitted', async () => {
    await start()
    const b = await addBuild()
    gateway.mode = 'fail'
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    const ev = openJob(r.json.jobId); await ev.done
    expect(ev.events.at(-1)).toMatchObject({ type: 'done', ok: false, result: { code: 'AUTH' } })
    const rec = (await api('GET', `/api/builds/${b.id}`)).json
    expect(rec).toMatchObject({ failCount: 1, lastInstall: { ok: false } })
    gateway.mode = 'retry'
    const r2 = await api('POST', `/api/builds/${b.id}/install`, {})
    const e2 = openJob(r2.json.jobId); await e2.done
    expect(e2.events.some((e) => e.type === 'log' && /retrying once/.test(e.line))).toBe(true)
  })
  it('a second install gets 409 INSTALL_IN_PROGRESS; delete of that build is 409 BUILD_BUSY; /api/run is refused', async () => {
    await start()
    const b = await addBuild()
    gateway.hold = true
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(r.status).toBe(202)
    const two = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(two.status).toBe(409); expect(two.json).toMatchObject({ code: 'INSTALL_IN_PROGRESS', jobId: r.json.jobId })
    expect((await api('DELETE', `/api/builds/${b.id}`, {})).json.code).toBe('BUILD_BUSY')
    expect((await api('GET', '/api/builds')).json.builds[0].installing).toBe(true)
    const run = await raw('GET', '/api/run?file=x.e2e.yaml')
    expect(run.status).toBe(409); expect(run.json.code).toBe('INSTALL_IN_PROGRESS')
    gateway.release()
    const ev = openJob(r.json.jobId); await ev.done
    expect(ev.events.at(-1).ok).toBe(true)
    expect((await api('POST', `/api/builds/${b.id}/install`, {})).status).toBe(202)
  })
  it('install is refused with RUN_IN_PROGRESS while a run is active', async () => {
    await start()
    fs.mkdirSync(path.join(dir, 'flows'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'flows', 'slow.e2e.yaml'), 'appId: dev\nsteps:\n  - wait: 10\n')
    const b = await addBuild()
    let runReq
    const started = new Promise((resolve) => { runReq = http.get({ host: '127.0.0.1', port, path: '/api/run?file=slow.e2e.yaml' }, (res) => { res.on('data', (c) => { if (String(c).includes('"start"')) resolve() }); res.on('error', () => {}) }); runReq.on('error', () => {}) })
    await started
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(r.status).toBe(409); expect(r.json.code).toBe('RUN_IN_PROGRESS')
    runReq.destroy()
    await until(async () => (await api('POST', `/api/builds/${b.id}/install`, {})).status === 202)
  })
  it('cancel before the upload starts: CANCELLED, nothing claimed about the device; NOT_RUNNING afterwards; unknown 404', async () => {
    await start()
    const b = await addBuild()
    gateway.hold = true; gateway.holdStep = 'probe'
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    await until(() => installs.length === 1)
    const c = await api('POST', `/api/builds/jobs/${r.json.jobId}/cancel`, {})
    expect(c.status).toBe(200); expect(c.json).toEqual({ cancelling: true })
    const ev = openJob(r.json.jobId); await ev.done
    const done = ev.events.at(-1)
    expect(done).toMatchObject({ ok: false, result: { code: 'CANCELLED' } })
    expect(done.result.message).not.toMatch(/may still finish/)
    const n = await api('POST', `/api/builds/jobs/${r.json.jobId}/cancel`, {})
    expect(n.status).toBe(409); expect(n.json.code).toBe('NOT_RUNNING')
    expect((await api('POST', '/api/builds/jobs/nope/cancel', {})).status).toBe(404)
  })
  it('cancel after the upload started says the device may still finish', async () => {
    await start()
    const b = await addBuild()
    gateway.hold = true; gateway.holdStep = 'upload'
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    await until(() => installs.length === 1)
    await api('POST', `/api/builds/jobs/${r.json.jobId}/cancel`, {})
    const ev = openJob(r.json.jobId); await ev.done
    expect(ev.events.at(-1).result.message).toMatch(/device may still finish installing/)
  })
  it('re-attach mid-install replays past events then follows live ones', async () => {
    await start()
    const b = await addBuild()
    gateway.hold = true
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    await until(() => installs.length === 1)
    const first = openJob(r.json.jobId)
    await until(() => first.events.length >= 1)
    first.abort() // the tab closed: the job goes on
    const second = openJob(r.json.jobId)
    await until(() => second.events.length >= 1)
    expect(second.events[0]).toMatchObject({ type: 'step', step: 'probe' })
    gateway.release()
    await second.done
    expect(second.events.at(-1)).toMatchObject({ type: 'done', ok: true })
  })
  it('releases the stream slot when a streamed install finishes: 10 in a row never hit 429', async () => {
    await start()
    const b = await addBuild()
    gateway.hold = true
    for (let i = 1; i <= 10; i++) {
      const r = await api('POST', `/api/builds/${b.id}/install`, {})
      expect(r.status, `install ${i}`).toBe(202)
      await until(() => installs.length === i)
      const ev = openJob(r.json.jobId)
      await until(() => ev.status !== null)
      expect(ev.status, `stream ${i}`).toBe(200)
      await until(() => ev.events.length >= 1)
      gateway.release()
      await ev.done
      expect(ev.events.at(-1)).toMatchObject({ type: 'done' })
    }
  })
  it('caps open streams at 8 with 429', async () => {
    await start()
    const b = await addBuild()
    gateway.hold = true
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    const open = []
    for (let i = 0; i < 8; i++) { const s = openJob(r.json.jobId); open.push(s); await until(() => s.status === 200) }
    const nine = openJob(r.json.jobId)
    await nine.done
    expect(nine.status).toBe(429)
    open.forEach((s) => s.abort())
    gateway.release()
  })
  it('423 LOCKED when another holder has the device; the install does not start', async () => {
    await start()
    const b = await addBuild()
    const l = await lease.acquire({ dir: path.join(dir, 'lease'), key: lease.keyFromAddress('127.0.0.1', Number(process.env.ROKU_ECP_PORT)), agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false, timers: false, identity: {} })
    try {
      const r = await api('POST', `/api/builds/${b.id}/install`, {})
      expect(r.status).toBe(423); expect(r.json.code).toBe('LOCKED')
      expect(installs).toHaveLength(0)
      expect((await api('GET', '/api/builds/current')).status).toBe(423)
      expect((await api('POST', `/api/builds/${b.id}/install`, {})).json.code).toBe('LOCKED') // the reservation was released
    } finally { l.release() }
  })
  it('install: 404 for an unknown build, 410 when the blob is gone', async () => {
    await start()
    expect((await api('POST', '/api/builds/b000000000000/install', {})).status).toBe(404)
    const b = await addBuild()
    fs.rmSync(path.join(dir, 'store', 'blobs', `${b.sha256}.zip`))
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(r.status).toBe(410); expect(r.json.code).toBe('BUILD_BLOB_MISSING')
  })
  it('device-less Studio: 400 NO_DEVICE', async () => {
    await start({ host: undefined, password: undefined })
    const prev = process.env.ROKU_HOST; delete process.env.ROKU_HOST
    try {
      const b = await addBuild()
      expect((await api('POST', `/api/builds/${b.id}/install`, {})).json.code).toBe('NO_DEVICE')
      expect((await api('GET', '/api/builds/current')).json.code).toBe('NO_DEVICE')
    } finally { if (prev !== undefined) process.env.ROKU_HOST = prev }
  })
})

describe('hub token check', () => {
  it('match installs; mismatch is 409 TOKEN_MISMATCH unless allowed; no-studio-token the same; enum only', async () => {
    await start()
    const b = await addBuild(makeZip(instrumentedEntries()))
    process.env.BRIGHTTEST_HUB_TOKEN = PKG_TOKEN
    const ok = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(ok.status).toBe(202); expect(ok.json.tokenCheck).toBe('match')
    await openJob(ok.json.jobId).done
    process.env.BRIGHTTEST_HUB_TOKEN = STUDIO_TOKEN
    const bad = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(bad.status).toBe(409); expect(bad.json).toMatchObject({ code: 'TOKEN_MISMATCH', tokenCheck: 'mismatch' })
    const allowed = await api('POST', `/api/builds/${b.id}/install`, { allowTokenMismatch: true })
    expect(allowed.status).toBe(202); expect(allowed.json.tokenCheck).toBe('mismatch')
    await openJob(allowed.json.jobId).done
    delete process.env.BRIGHTTEST_HUB_TOKEN
    const none = await api('POST', `/api/builds/${b.id}/install`, {})
    expect(none.status).toBe(409); expect(none.json.tokenCheck).toBe('no-studio-token')
  })
})

describe('GET /api/builds/current', () => {
  let stub, appsXml
  const startStub = async () => {
    stub = http.createServer((q, s) => {
      const xml = q.url === '/query/apps' ? appsXml : q.url === '/query/active-app' ? '<active-app><app id="dev" type="appl">Sample App</app></active-app>' : '<device-info><model-name>Fake</model-name></device-info>'
      s.end(`<?xml version="1.0"?>${xml}`)
    })
    await new Promise((res) => stub.listen(0, '127.0.0.1', res))
    process.env.ROKU_ECP_PORT = String(stub.address().port)
  }
  afterEach(() => { if (stub) stub.close() })
  const installersJson = () => {
    const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((n) => walk(path.join(p, n))) : [p]
    return walk(path.join(dir, 'lease')).filter((f) => f.endsWith('installed.json'))
  }

  it('the fake Roku reports a dev channel nothing installed here: unknown, no build', async () => {
    await start()
    await addBuild()
    const r = (await api('GET', '/api/builds/current')).json
    expect(r).toMatchObject({ host: '127.0.0.1', devApp: { title: 'Fake Channel', version: '1.0.0' }, build: null, match: 'unknown', source: null })
    expect(r.active).toBeTruthy()
  })
  it('installed.json first (confirmed / probable / unknown / none), then the store record', async () => {
    appsXml = '<apps><app id="dev" type="appl" version="1.4.118">Sample App</app></apps>'
    await startStub()
    await start()
    const b = await addBuild()
    const j = await api('POST', `/api/builds/${b.id}/install`, {})
    await openJob(j.json.jobId).done
    const c = (await api('GET', '/api/builds/current')).json
    expect(c).toMatchObject({ source: 'installed', match: 'confirmed', build: { id: b.id }, installed: { via: 'studio' }, devApp: { title: 'Sample App', version: '1.4.118' } })
    expect(JSON.stringify(c)).not.toMatch(/leaseId/)
    appsXml = '<apps><app id="dev" type="appl">Sample App</app></apps>'
    expect((await api('GET', '/api/builds/current')).json.match).toBe('probable')
    appsXml = '<apps><app id="dev" type="appl" version="9.9.9">Other</app></apps>'
    expect(await api('GET', '/api/builds/current').then((r) => r.json)).toMatchObject({ match: 'unknown', build: null })
    appsXml = '<apps><app id="1001" type="appl" version="1.0.0">Other</app></apps>'
    expect((await api('GET', '/api/builds/current')).json).toMatchObject({ match: 'none', devApp: null })
    // no installed.json: the store's newest successful install on this host answers
    for (const f of installersJson()) fs.rmSync(f)
    appsXml = '<apps><app id="dev" type="appl" version="1.4.118">Sample App</app></apps>'
    const s2 = (await api('GET', '/api/builds/current')).json
    expect(s2).toMatchObject({ source: 'store', match: 'confirmed', build: { id: b.id } })
  })
})

describe('secrets never appear', () => {
  it('no password, hub token or package token in any response or event of the routes above', async () => {
    await start()
    const b = await addBuild(makeZip(instrumentedEntries()))
    process.env.BRIGHTTEST_HUB_TOKEN = PKG_TOKEN
    gateway.mode = 'retry'
    const r = await api('POST', `/api/builds/${b.id}/install`, {})
    const ev = openJob(r.json.jobId); await ev.done
    gateway.mode = 'fail'
    process.env.BRIGHTTEST_HUB_TOKEN = STUDIO_TOKEN
    await api('POST', `/api/builds/${b.id}/install`, {})
    const f = await api('POST', `/api/builds/${b.id}/install`, { allowTokenMismatch: true })
    await openJob(f.json.jobId).done
    await api('GET', '/api/builds'); await api('GET', `/api/builds/${b.id}`); await api('GET', '/api/builds/current')
    await api('GET', '/api/device')
    const all = seen.join('\n') + JSON.stringify(ev.events)
    expect(all).toContain('***') // the scrubber ran on the fake installer's messages
    for (const s of [PASSWORD, STUDIO_TOKEN]) expect(all).not.toContain(s)
    // the package token lives inside the zip blob only, never in a JSON body (the download is the zip itself)
    const jsonOnly = seen.filter((t) => t.startsWith('{') || t.startsWith('data:')).join('\n')
    expect(jsonOnly).not.toContain(PKG_TOKEN)
    const rec = fs.readFileSync(path.join(dir, 'store', 'records', `${b.id}.json`), 'utf8')
    for (const s of [PASSWORD, STUDIO_TOKEN, PKG_TOKEN]) expect(rec).not.toContain(s)
    const lease = path.join(dir, 'lease')
    const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((n) => walk(path.join(p, n))) : [p]
    for (const file of walk(lease)) { const t = fs.readFileSync(file, 'utf8'); for (const s of [PASSWORD, STUDIO_TOKEN, PKG_TOKEN]) expect(t).not.toContain(s) }
  })
})
