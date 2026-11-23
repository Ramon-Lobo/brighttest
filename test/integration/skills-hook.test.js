import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ADOPT-09: the hook entry that `skills install --with-hook` writes really denies a raw device curl.
// The installed command points at node_modules/brighttest; the temp project gets a symlink to this checkout.
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const CLI = path.join(ROOT, 'bin', 'cli.js')
let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hook-int-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const env = () => {
  const e = { ...process.env, BRIGHTTEST_LEASE_DIR: path.join(dir, 'leases'), BRIGHTTEST_CACHE: path.join(dir, 'devices.json'), CLAUDE_PROJECT_DIR: dir }
  delete e.BRIGHTTEST_LEASE; delete e.ROKU_HOST; delete e.ROKU_PASSWORD
  return e
}

describe('installed guard hook', () => {
  it('denies a raw curl to a device host and allows an unrelated command', () => {
    const r = spawnSync(process.execPath, [CLI, 'skills', 'install', '--agent', 'claude', '--with-hook'], { cwd: dir, env: env(), encoding: 'utf8', timeout: 60000 })
    expect(r.status).toBe(0)
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    fs.symlinkSync(ROOT, path.join(dir, 'node_modules', 'brighttest'), 'dir')
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'))
    const hook = settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash').hooks[0]
    const call = (command) => spawnSync('/bin/sh', ['-c', hook.command], { cwd: dir, env: env(), encoding: 'utf8', timeout: 30000, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'test' }) })
    const denied = call('curl http://192.0.2.10:8060/keypress/Home')
    expect(denied.status).toBe(0)
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    const ok = call('ls -la')
    expect(ok.status).toBe(0)
    expect(ok.stdout.trim()).toBe('')
  })
})
