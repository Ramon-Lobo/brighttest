import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const store = require('../lib/instrument/hub-token-store')
const cli = path.resolve(__dirname, '../bin/cli.js')
const T1 = '11'.repeat(16)
const T2 = '22'.repeat(16)
let dir
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-htsb-'))
  fs.mkdirSync(path.join(dir, 'source'))
  fs.writeFileSync(path.join(dir, 'manifest'), 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n')
  fs.writeFileSync(path.join(dir, 'source/main.brs'), 'sub main()\nend sub\n')
  fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify({ instrument: { hub: { host: 'hub.example.test', port: 9123 } } }))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const bt = (args, token) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_HUB_TOKEN: token || '' } })

describe('instrument build --net keeps the hub token', () => {
  it('stores it per package, net token --ensure reuses it, a different token is a different package', () => {
    const a = bt(['instrument', 'build', '--net', '--out', 'a.zip'], T1)
    expect(a.status).toBe(0)
    const shaA = store.sha256File(path.join(dir, 'a.zip'))
    expect(a.stderr + a.stdout).toContain(shaA.slice(0, 12))
    expect(a.stderr + a.stdout).not.toContain(T1)
    const file = path.join(dir, '.brighttest/hub-tokens', `${shaA}.json`)
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe(T1)

    const e = bt(['net', 'token', '--ensure'])
    expect(e.status).toBe(0)
    expect(e.stdout).toContain('reused')
    expect(e.stdout).toContain(shaA.slice(0, 12))
    expect(e.stdout + e.stderr).not.toContain(T1)

    const b = bt(['instrument', 'build', '--net', '--out', 'b.zip'], T2)
    expect(b.status).toBe(0)
    const shaB = store.sha256File(path.join(dir, 'b.zip'))
    expect(shaB).not.toBe(shaA)
    expect(store.readLatest(dir)).toMatchObject({ sha256: shaB, token: T2 })
    expect(store.mismatchMessage(store.latestSha(dir))).toContain(shaB.slice(0, 12))
    expect(store.mismatchMessage(shaB)).not.toContain(T2)
  })
})
