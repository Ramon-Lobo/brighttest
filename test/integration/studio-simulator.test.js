import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// The simulator target on the real stock brs-node engine, no device: ready(), a state write reaching `reflected`,
// a read, a clean stop, and the watchdog ending the child when the parent is killed with SIGKILL.
const require = createRequire(import.meta.url)
const repo = path.resolve(__dirname, '../..')
const { startSimulator } = require('../../lib/studio/simulator.js')
const { loadConfig } = require('../../lib/config.js')
const engines = require('../../lib/engines.js')

let stock = null
try { stock = engines.resolveEngine('brsNode', 'stock') } catch (e) { if (!e || e.code !== 'ENGINE_MISSING') throw e /* only a missing engine skips */ }
if (!stock) console.log('studio-simulator integration skipped: stock brs-node is not resolvable (install it with: npm i --no-save brs-node@~2.7.1)')
const d = stock ? describe : describe.skip

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
})
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)) } return false }

let tmp, app
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sim-int-'))
  app = path.join(tmp, 'app')
  fs.cpSync(path.join(repo, 'examples/greenfield-app'), app, { recursive: true })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function send(hub, op, args, ack) {
  const full = hub.push({ op, args, ack }, { ack })
  let c
  const ok = await until(() => { c = hub.stateOps.get(full.id); return c && c.status !== 'pending' }, 15000)
  expect(ok, `${op} did not settle`).toBe(true)
  return c
}

d('studio simulator on stock brs-node', () => {
  it('ready(), set reaches reflected, get returns premium, stop leaves no child and a closed port', async () => {
    const cfg = loadConfig(app)
    const sim = await startSimulator({ cfg, rootDir: app, log: () => {} })
    const pid = sim.info().pid
    const port = sim.net.hub.port
    try {
      console.log(`engine ${stock.name}@${stock.version} (${stock.flavor}), child pid ${pid}`)
      await sim.ready()
      expect(sim.info().state).toBe('running')
      const set = await send(sim.net.hub, 'set', { layer: 'global', path: 'btstate_user.tier', value: 'premium' }, 'reflected')
      expect(set).toMatchObject({ status: 'done', phase: 'reflected' })
      const got = await send(sim.net.hub, 'get', { layer: 'global', path: 'btstate_user.tier' }, 'applied')
      expect(JSON.stringify(got.result)).toContain('premium')
    } finally {
      await sim.stop()
    }
    expect(alive(pid)).toBe(false)
    expect(fs.existsSync(path.join(cfg.stagingDir, 'simulator', 'child.pid'))).toBe(false)
    expect(await portOpen(port)).toBe(false)
  }, 90000)

  it('kill -9 of the parent ends the child within 2 s (watchdog)', async () => {
    const script = `
      const { startSimulator } = require(${JSON.stringify(path.join(repo, 'lib/studio/simulator.js'))});
      const { loadConfig } = require(${JSON.stringify(path.join(repo, 'lib/config.js'))});
      (async () => {
        const sim = await startSimulator({ cfg: loadConfig(${JSON.stringify(app)}), rootDir: ${JSON.stringify(app)}, log: () => {} });
        await sim.ready();
        process.stdout.write('READY ' + sim.info().pid + '\\n');
        setInterval(() => {}, 1000);
      })().catch((e) => { process.stderr.write(String(e.stack || e) + '\\n'); process.exit(1) });
    `
    const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    parent.stdout.on('data', (b) => { out += b }); parent.stderr.on('data', (b) => { err += b })
    let childPid = null
    try {
      const ready = await until(() => /READY \d+/.test(out) || parent.exitCode !== null, 60000)
      expect(ready && /READY \d+/.test(out), `parent did not become ready: ${err}`).toBe(true)
      childPid = Number(/READY (\d+)/.exec(out)[1])
      expect(alive(childPid)).toBe(true)
      const t0 = Date.now()
      process.kill(parent.pid, 'SIGKILL')
      const gone = await until(() => !alive(childPid), 2000)
      console.log(`child gone ${Date.now() - t0} ms after kill -9 of the parent`)
      expect(gone).toBe(true)
    } finally {
      try { parent.kill('SIGKILL') } catch { /* gone */ }
      if (childPid && alive(childPid)) { try { process.kill(childPid, 'SIGKILL') } catch { /* gone */ } }
    }
  }, 90000)
})
