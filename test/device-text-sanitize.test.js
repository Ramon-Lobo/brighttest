import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import deviceCommand from '../lib/device-command.js'
import { loadConfig } from '../lib/config.js'
import { parseDeviceArgs } from '../bin/cli.js'
import tui from '../lib/tui.js'

const HOST = '127.0.0.1'
const ESC = '\u001b', BEL = '\u0007'
const PURPOSE = `${ESC}]0;pwned${BEL}${ESC}[31mred${ESC}[0m c1:\u009b31m\u0085\u009d x${String.fromCharCode(0x7f)} café ✓ 日本`
const AGENT = `${ESC}]8;;http://x${ESC}\\agent${ESC}]8;;${ESC}\\`
const BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

let dir, out, errs, saved
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-san-'))
  saved = { d: process.env.BRIGHTTEST_LEASE_DIR, l: process.env.BRIGHTTEST_LEASE }
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'none.json')
  delete process.env.BRIGHTTEST_LEASE
  out = []; errs = []
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)))
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { errs.push(String(s)); return true })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved.d === undefined) delete process.env.BRIGHTTEST_LEASE_DIR; else process.env.BRIGHTTEST_LEASE_DIR = saved.d
  if (saved.l !== undefined) process.env.BRIGHTTEST_LEASE = saved.l
  delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})
const dev = (args) => deviceCommand.run(parseDeviceArgs(args), loadConfig(dir, null))

describe('device text output strips control characters', () => {
  it('sanitizeLines keeps newlines and unicode, drops escapes', () => {
    expect(tui.sanitizeLines(`a${ESC}]0;t${BEL}b\nc${ESC}[1mD\u009b`)).toBe('ab\ncD')
  })

  it('status, log, wait line and unlock print clean text; --json stays escaped', async () => {
    expect(await dev(['lock', '--host', HOST, '--no-hygiene', '--as', AGENT, '--purpose', PURPOSE, '--idle', '60s', '--max', '120s', '--json'])).toBe(0)
    const tok = JSON.parse(out[0]).leaseId
    out.length = 0

    await dev(['status'])
    const status = out.join('\n')
    expect(status).not.toMatch(BAD)
    expect(status).not.toContain('pwned') // the whole OSC sequence, payload included, is dropped
    expect(status).toContain('café ✓ 日本')
    expect(status).not.toContain(ESC)

    out.length = 0
    await dev(['log'])
    const log = out.join('\n')
    expect(log).not.toMatch(BAD)
    expect(log).toContain('café ✓ 日本')

    // a second taker is told who holds the device: stderr must be clean too
    errs.length = 0
    expect(await dev(['with', '--host', HOST, '--no-hygiene', '--as', 'other', '--wait', '0', '--', process.execPath, '-e', '0'])).toBe(75)
    expect(errs.join('')).not.toMatch(BAD)
    expect(errs.join('')).toContain('café')

    // --json: same shape, control bytes only as \u escapes, parsed value unchanged
    out.length = 0
    await dev(['status', '--json'])
    const raw = out.join('\n')
    expect(raw).not.toMatch(BAD)
    expect(raw).toContain('\\u001b]0;pwned')
    expect(raw).toContain('\\u009b')
    expect(JSON.parse(raw)[0].holder.holder.purpose).toBe(PURPOSE)
    out.length = 0
    await dev(['log', '--json'])
    expect(out.join('\n')).not.toMatch(BAD)
    expect(JSON.parse(out.join('\n')).some((e) => e.purpose === PURPOSE)).toBe(true)

    out.length = 0
    await dev(['unlock', '--lease', tok])
    expect(out.join('\n')).not.toMatch(BAD)
  })
})
