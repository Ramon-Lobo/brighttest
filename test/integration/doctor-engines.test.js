import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProject, makeEmptyDir, cleanupTemp, enginesArePatched, patchedOnly } from './helpers.js'

afterAll(cleanupTemp)
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js')

// A fake brs-node engine whose bin prints canned CAP lines (the probe app is not interpreted).
function fakeEngine(dir, name, { stamp, caps }) {
  const d = path.join(dir, 'node_modules', ...name.split('/'))
  fs.mkdirSync(path.join(d, 'bin'), { recursive: true })
  const pkg = { name, version: stamp ? '2.7.0-bt.1' : '2.7.0', bin: { 'brs-cli': 'bin/cli.js' } }
  if (stamp) pkg.brighttest = stamp
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg))
  const lines = Object.entries(caps).map(([id, v]) => `CAP ${id} ${v}`)
  fs.writeFileSync(path.join(d, 'bin', 'cli.js'), `console.log(${JSON.stringify(lines.join('\n'))})\n`)
  return d
}
function doctor(dir, env = {}, args = ['doctor', '--engines']) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_ENGINES: '', ...env } })
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' }
}
const PATCHED = { 'BRS-01': 1, 'BRS-02': 1, 'BRS-03': 1, 'BRS-04': 1, 'BRS-06': 1 }
const STAMP = { patches: { 'BRS-01': 1, 'BRS-02': 1, 'BRS-03': 1, 'BRS-04': 1, 'BRS-06': 1 }, nonDevice: ['BRS-02'] }

describe('doctor --engines', () => {
  // The installed engine must be the stamped build: BRS-02 (Label.forceUpperCase) exists only in the patched brs-node,
  // so a stock install has no such row. The tests below use fake engines and clear BRIGHTTEST_ENGINES so they
  // exercise the same code on every flavor.
  it.skipIf(!enginesArePatched())(patchedOnly('real installed engine: runs the probe app and exits 0 (TP-ENG-05 headless rows)'), () => {
    const r = doctor(makeEmptyDir())
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/BRS-02\s+\S+\s+yes\s+.*NON-DEVICE/)
    expect(r.out).toContain('probe: ok')
  })

  it('patched flavor: table shows BRS-02 non-device (TP-ENG-06), exit 0', () => {
    const dir = makeEmptyDir()
    fakeEngine(dir, '@ramonlobo/brs-node', { stamp: STAMP, caps: PATCHED })
    const r = doctor(dir)
    expect(r.status).toBe(0)
    expect(r.out).toContain('flavor: patched')
    expect(r.out).toMatch(/BRS-02\s+yes\s+yes\s+.*NON-DEVICE/)
    expect(r.out).toContain('metadata and probe agree')
  })

  it('stock flavor: BRS-02 absent, exit 0 (TP-ENG-06/08)', () => {
    const dir = makeEmptyDir()
    fakeEngine(dir, 'brs-node', { caps: { ...PATCHED, 'BRS-01': 0, 'BRS-02': 0, 'BRS-03': 0, 'BRS-04': 0, 'BRS-06': 0 } })
    const roo = path.join(dir, 'node_modules', 'rooibos-roku')
    fs.mkdirSync(roo, { recursive: true })
    fs.writeFileSync(path.join(roo, 'package.json'), JSON.stringify({ name: 'rooibos-roku', version: '5.17.0' }))
    const r = doctor(dir, { BRIGHTTEST_ENGINES: 'stock' })
    expect(r.status).toBe(0)
    expect(r.out).toContain('flavor: stock')
    expect(r.out).toMatch(/BRS-02\s+absent\s+absent\s+.*NON-DEVICE/)
  })

  it('stamp without BRS-06 (detached findNode dropped) and with CLI-level BRS-07/BRS-08: metadata-only rows, exit 0', () => {
    const dir = makeEmptyDir()
    const { 'BRS-06': _drop, ...patches } = STAMP.patches
    fakeEngine(dir, '@ramonlobo/brs-node', { stamp: { ...STAMP, patches: { ...patches, 'BRS-07': 1, 'BRS-08': 1 } }, caps: { ...PATCHED, 'BRS-06': 0 } })
    const r = doctor(dir)
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/BRS-06\s+absent\s+absent/)
    expect(r.out).toMatch(/BRS-07\s+yes\s+n\/a/)
    expect(r.out).toMatch(/BRS-08\s+yes\s+n\/a/)
    expect(r.out).toContain('metadata and probe agree')
  })

  it('metadata claims a patch the probe lacks: hard failure naming both values (TP-ENG-11)', () => {
    const dir = makeEmptyDir()
    fakeEngine(dir, '@ramonlobo/brs-node', { stamp: { ...STAMP, patches: { ...STAMP.patches, 'BRS-06': 1 } }, caps: { ...PATCHED, 'BRS-06': 0 } })
    const r = doctor(dir)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('MISMATCH BRS-06: metadata says yes, probe says absent')
  })

  it('code lost a patch the metadata still claims: hard failure (TP-ENG-11)', () => {
    const dir = makeEmptyDir()
    fakeEngine(dir, '@ramonlobo/brs-node', { stamp: STAMP, caps: { ...PATCHED, 'BRS-03': 0 } })
    const r = doctor(dir)
    expect(r.status).toBe(1)
    expect(r.err).toContain('MISMATCH BRS-03: metadata says yes, probe says absent')
  })

  it('probe with no CAP output fails; --json is machine readable', () => {
    const dir = makeEmptyDir()
    fakeEngine(dir, '@ramonlobo/brs-node', { stamp: STAMP, caps: {} })
    expect(doctor(dir).status).toBe(1)
    const ok = makeEmptyDir()
    fakeEngine(ok, '@ramonlobo/brs-node', { stamp: STAMP, caps: PATCHED })
    const j = JSON.parse(doctor(ok, {}, ['doctor', '--engines', '--json']).out)
    expect(j).toMatchObject({ ok: true, brsNode: { flavor: 'patched' } })
  })
})

describe('run-time non-device warning (TP-ENG-09)', () => {
  function runWith(env, extra) {
    const dir = makeProject()
    fs.mkdirSync(path.join(dir, 'source', 'tests'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'Title.spec.bs'), extra)
    fakeEngine(dir, '@ramonlobo/brs-node', { stamp: STAMP, caps: PATCHED })
    fakeEngine(dir, 'brs-node', { caps: {} })
    const r = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_ENGINES: '', ...env } })
    return r.stderr || ''
  }
  it('patched run names file:line; stock run and unrelated source stay silent', () => {
    const used = '\nsub t()\n  l.forceUpperCase = true\nend sub\n'
    expect(runWith({}, used)).toMatch(/nondevice-field: Label\.forceUpperCase used in source\/tests\/Title\.spec\.bs:3 /)
    expect(runWith({ BRIGHTTEST_ENGINES: 'stock' }, used)).not.toContain('nondevice-field')
    expect(runWith({}, "' nothing\n")).not.toContain('nondevice-field')
  })
})
