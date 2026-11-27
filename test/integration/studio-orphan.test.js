import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// STUDIO-ORPHAN-ON-KILL: under `npm exec` (npm_command=exec) Studio stops when its parent is SIGKILLed; without it
// the child keeps running as before. POSIX only; the fake Roku stands in for the device, no real device is touched.
const require = createRequire(import.meta.url)
const repo = path.resolve(__dirname, '../..')
const { createFakeRoku } = require('../fixtures/fake-roku/server.js')
const uiBuilt = fs.existsSync(path.join(repo, 'lib/studio/public/index.html'))
if (!uiBuilt) console.log('studio-orphan integration skipped: the Studio bundle is not built (npm run studio:build)')
const d = process.platform !== 'win32' && uiBuilt ? describe : describe.skip

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const canConnect = (port) => new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true) }); c.on('error', () => r(false)) })
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)) } return false }

let tmp, fake
const killed = []
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-orphan-'))
  if (process.platform !== 'win32' && uiBuilt) { fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 }); fake.ports = await fake.start() }
})
afterAll(async () => {
  for (const p of killed) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
  if (fake) await fake.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// Parent script: spawns Studio, prints its pid and waits to be killed.
const PARENT = `
const { spawn } = require('child_process');
const c = spawn(process.execPath, [process.env.CLI, 'studio', '--host', '127.0.0.1', '--port', process.env.PORT], { stdio: ['ignore', 'ignore', process.env.DBG ? 'inherit' : 'ignore'] });
console.log('CHILD ' + c.pid);
setInterval(() => {}, 1000);
`

async function launch(npmCommand) {
  const port = await freePort()
  const env = { ...process.env, CLI: path.join(repo, 'bin/cli.js'), PORT: String(port), HOME: tmp, XDG_CONFIG_HOME: tmp, BRIGHTTEST_CACHE: path.join(tmp, 'devices.json'), ROKU_ECP_PORT: String(fake.ports.ecp || fake.ports.ecpPort), ROKU_PASSWORD: 'rokudev-test' }
  delete env.npm_command
  if (npmCommand) env.npm_command = npmCommand
  const parent = spawn(process.execPath, ['-e', PARENT], { cwd: tmp, env, stdio: ['ignore', 'pipe', process.env.DBG ? 'inherit' : 'ignore'] })
  killed.push(parent.pid)
  const pid = await new Promise((resolve, reject) => {
    let out = ''
    parent.stdout.on('data', (b) => { out += b; const m = /CHILD (\d+)/.exec(out); if (m) resolve(Number(m[1])) })
    setTimeout(() => reject(new Error('no child pid')), 10000)
  })
  killed.push(pid)
  expect(await until(() => canConnect(port), 15000)).toBe(true)
  return { parent, pid, port }
}

d('studio parent watch', () => {
  it('stops Studio and frees the port within 5 s of the npm parent being SIGKILLed', async () => {
    const { parent, pid, port } = await launch('exec')
    process.kill(parent.pid, 'SIGKILL')
    expect(await until(() => !alive(pid) , 5000)).toBe(true)
    expect(await until(async () => !(await canConnect(port)), 2000)).toBe(true)
  }, 40000)

  it('keeps today\'s behaviour without npm_command: the child survives its parent', async () => {
    const { parent, pid, port } = await launch(null)
    process.kill(parent.pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 4500))
    expect(alive(pid)).toBe(true)
    expect(await canConnect(port)).toBe(true)
    process.kill(pid, 'SIGKILL')
    expect(await until(() => !alive(pid), 3000)).toBe(true)
  }, 40000)
})
