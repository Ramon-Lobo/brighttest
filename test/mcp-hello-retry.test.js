import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// MCP-HELLO-RETRY: BT_wHelloBackoff schedule (headless engine) and its use in the agent Task (static check; the Task
// and real hello timing need a device, DQ-081).
const brsCli = path.resolve(__dirname, '../node_modules/@ramonlobo/brs-node/bin/brs.cli.js')
const RT = path.resolve(__dirname, '../lib/instrument/runtime')
const strip = (f) => fs.readFileSync(path.join(RT, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const fn = strip('source/bt/BT_write.brs').match(/function BT_wHelloBackoff[\s\S]*?end function/)[0]

let tmp, seq
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hello-'))
  fs.writeFileSync(path.join(tmp, 'h.brs'), `${fn}\nsub main()\n    o = []\n    for i = 0 to 6\n        o.push(BT_wHelloBackoff(i))\n    end for\n    print "S:" + FormatJson(o)\nend sub\n`)
  const child = spawn(process.execPath, [brsCli, '-r', '.', 'h.brs'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  child.stdout.on('data', (d) => { out += d })
  await new Promise((resolve) => child.on('close', () => { clearTimeout(timer); resolve() }))
  seq = JSON.parse(out.split(/\r?\n/).find((x) => x.startsWith('S:')).slice(2))
}, 90000)
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('agent hello backoff', () => {
  it('is 2, 2, 5, 5 s and then 30 s', () => {
    expect(seq).toEqual([2000, 2000, 5000, 5000, 30000, 30000, 30000])
  })
  it('sends at most 7 hellos in the first minute without a hub, and a hub opened late is found within 5 s of a retry', () => {
    let t = 0, n = 1 // hello at 0
    const times = [0]
    for (let f = 0; t < 60000; f++) { t += seq[Math.min(f, 6)]; if (t < 60000) { n++; times.push(t) } }
    expect(n).toBeLessThanOrEqual(7)
    expect(times.slice(0, 5)).toEqual([0, 2000, 4000, 9000, 14000])
  })
  it('the Task uses it for a failed hello, resets on success, and keeps 30 s for stop and 5 s for error', () => {
    const src = fs.readFileSync(path.join(RT, 'components/bt/BT_AgentTask.brs'), 'utf8')
    expect(src).toMatch(/retryAt = now \+ BT_wHelloBackoff\(helloFails\)/)
    expect(src).toMatch(/then helloFails = helloFails \+ 1 else helloFails = 0/)
    expect(src).not.toMatch(/if session = "" then retryAt = now \+ 30000/)
    expect(src).toMatch(/"stop" then[\s\S]*?\+ 30000/)
  })
})
