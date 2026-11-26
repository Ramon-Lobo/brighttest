import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { startHub, startLanHub, localLease } = require('../lib/instrument/hub.js')

const TOKEN = 'tok-abcdef0123456789'
const hubs = []
afterEach(async () => { await Promise.all(hubs.splice(0).map((h) => h.stop())) })

async function start(o = {}) {
  const hub = await startHub({ host: '127.0.0.1', port: 0, mode: 'headless', lease: localLease(), tokens: [TOKEN], ...o })
  hubs.push(hub)
  return hub
}
function get(hub, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: hub.port, path, agent: false }, (res) => {
      let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    }).on('error', reject)
  })
}
const netHello = (hub) => get(hub, `/bt/${TOKEN}/hello?role=net`)

describe('test-only resync switch', () => {
  it('is inert when unset: a net hello answers, nothing is queued, nothing is recorded', async () => {
    const hub = await start()
    const r = await netHello(hub)
    expect(r.status).toBe(200)
    expect(hub.stateOps.list()).toHaveLength(0)
    expect(hub.testLog).toEqual([])
  })

  it('ignores unknown names', async () => {
    const hub = await start({ testSwitch: 'nope, ,x' })
    expect((await netHello(hub)).status).toBe(200)
    expect(hub.testLog).toEqual([])
  })

  it('net-hello-drop: the net hello fails with no reply, is still counted, and the agent hello is untouched', async () => {
    const hub = await start({ testSwitch: 'net-hello-drop' })
    await expect(netHello(hub)).rejects.toBeTruthy()
    expect(hub.netHellos).toBe(1)
    expect((await get(hub, `/bt/${TOKEN}/hello`)).status).toBe(200)
  })

  it('net-hello-log: records each net hello so the 3 s retry gate can be read across threads', async () => {
    const hub = await start({ testSwitch: ['net-hello-log'] })
    await netHello(hub); await netHello(hub)
    const log = hub.testLog
    expect(log).toHaveLength(2)
    expect(log[1].at).toBeGreaterThanOrEqual(log[0].at)
    expect(log[0].open).toBe(0)
  })

  it('net-hello-pending: a command is open when the net hello arrives and it stays open (not abandoned)', async () => {
    const hub = await start({ testSwitch: 'net-hello-pending,net-hello-log' })
    expect((await netHello(hub)).status).toBe(200)
    const open = hub.stateOps.list().filter((c) => c.status === 'pending')
    expect(open).toHaveLength(1)
    expect(open[0].op).toBe('ping')
    expect(hub.testLog[0].open).toBe(1)
    await netHello(hub)
    expect(hub.stateOps.list().filter((c) => c.status === 'pending')).toHaveLength(1) // one is enough; none added
  })

  it('startLanHub reads BRIGHTTEST_TEST_SWITCH from the env it is given', async () => {
    const lease = { leaseId: 'l1', lost: false, onLost: null, onExpire: null }
    const hub = await startLanHub({ deviceHost: '192.168.1.77', lease, tokens: [TOKEN], bindHost: '127.0.0.1', peerOf: () => '192.168.1.77', env: { BRIGHTTEST_TEST_SWITCH: 'net-hello-log' } })
    hubs.push(hub)
    await netHello(hub)
    expect(hub.testLog).toHaveLength(1)
  })

  it('startLanHub with no env switch records nothing', async () => {
    const lease = { leaseId: 'l2', lost: false, onLost: null, onExpire: null }
    const hub = await startLanHub({ deviceHost: '192.168.1.78', lease, tokens: [TOKEN], bindHost: '127.0.0.1', peerOf: () => '192.168.1.78', env: {} })
    hubs.push(hub)
    await netHello(hub)
    expect(hub.testLog).toEqual([])
  })
})
