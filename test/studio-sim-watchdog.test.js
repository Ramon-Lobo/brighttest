import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'

const watchdog = path.resolve(__dirname, '../lib/studio/sim-watchdog.js')

describe('sim-watchdog preload', () => {
  it('exits the child when the parent disconnects the IPC channel', async () => {
    const child = spawn(process.execPath, ['-r', watchdog, '-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })))
    await new Promise((r) => setTimeout(r, 300))
    child.disconnect()
    const t0 = Date.now()
    const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
    if (res === 'timeout') child.kill('SIGKILL')
    expect(res).toEqual({ code: 0, sig: null })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
