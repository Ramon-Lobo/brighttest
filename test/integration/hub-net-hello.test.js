import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { startHub } = require('../../lib/instrument/hub.js')

const TOKEN = 'tok-abcdef0123456789'
const hubs = []
afterEach(async () => { while (hubs.length) await hubs.pop().stop() })

function req(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: hub.port, path: p, method }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    r.on('error', reject); r.end(body)
  })
}

describe('net hello does not disturb the agent session', () => {
  it('a pending command stays pending across a net hello from a second client and acks into the original session', async () => {
    const lease = { held: () => true, onLost() {}, leaseId: 'l1' }
    const hub = await startHub({ host: '127.0.0.1', port: 0, mode: 'headless', lease, tokens: [TOKEN], netProxy: { handle() {} } })
    hubs.push(hub)
    const agent = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/hello`)).body)
    const q = JSON.parse((await req(hub, 'POST', `/bt/${TOKEN}/state`, JSON.stringify({ op: 'ping' }))).body)
    const net = await req(hub, 'GET', `/bt/${TOKEN}/hello?role=net`)
    expect(net.status).toBe(200)
    expect(JSON.parse(net.body).netBase).toBe(`/bt/${TOKEN}/net/;`)
    expect(hub.stateOps.get(q.id).status).toBe('pending')
    const ack = JSON.stringify({ kind: 'cmd.ack', session: agent.session, data: { id: q.id, seq: q.seq, phase: 'applied', ok: true } }) + '\n'
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack)
    expect(hub.stateOps.get(q.id)).toMatchObject({ status: 'done', ok: true })
    expect(hub.sessionId).toBe(agent.session)
  })
})
