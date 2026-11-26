import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import lease from '../lib/device-lease.js'
import hook from '../lib/device-hook.js'

const { classify, main } = hook
const HOST = '127.0.0.1'
const VALID = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const EXPIRED = '0123456789abcdef01234567'
const opts = { hosts: [HOST], leaseValid: (t) => t === VALID }

// The TP-LSE-21 rows (a..w) plus extra cases from design section 4.9.
const TABLE = [
  ['a', 'ls -la', 'allow'],
  ['b', 'grep 127.0.0.1 notes.md', 'allow'],
  ['c', `curl -s http://${HOST}:8060/query/device-info`, 'allow'],
  ['c2', `curl -s http://${HOST}:8060/query/active-app`, 'allow'],
  ['c3', `curl -s http://${HOST}:8060/query/apps`, 'allow'],
  ['c4', `curl -s http://${HOST}:8060/query/icon/12`, 'deny'],
  ['c5', `curl -s -X POST http://${HOST}:8060/query/device-info`, 'deny'],
  ['c6', `curl -s http://${HOST}:8060/query/device-info http://${HOST}:8060/keypress/Home`, 'deny'],
  ['c7', `curl -s -d '' http://${HOST}:8060/query/device-info`, 'deny'],
  ['d', `curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['d2', `curl http://${HOST}:8060/keypress/Home -X POST`, 'deny'],
  ['d3', `curl -s -XPOST http://${HOST}:8060/keypress/Home`, 'deny'],
  ['d4', `curl ${HOST}:8060/keypress/Home`, 'deny'],
  ['e', `node bin/cli.js device with -- curl -d '' http://${HOST}:8060/keypress/Home`, 'allow'],
  ['e2', `brighttest device with --as dev#1 --purpose x -- curl -d '' http://${HOST}:8060/keypress/Home`, 'allow'],
  ['f', `BRIGHTTEST_LEASE=${VALID} curl -d '' http://${HOST}:8060/keypress/Home`, 'allow'],
  ['g', `BRIGHTTEST_LEASE=${EXPIRED} curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['g2', `BRIGHTTEST_LEASE=short curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['g3', `BRIGHTTEST_LEASE=${VALID} BRIGHTTEST_NO_LEASE=1 curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['h', 'BRIGHTTEST_NO_LEASE=1 node bin/cli.js e2e run x', 'deny'],
  ['h2', 'export BRIGHTTEST_NO_LEASE=1', 'deny'],
  ['h3', 'env BRIGHTTEST_NO_LEASE=1 brighttest --device', 'deny'],
  ['h4', 'echo BRIGHTTEST_NO_LEASE=1', 'allow'],
  ['i', 'node bin/cli.js e2e run flows/a.e2e.yaml --no-lease', 'deny'],
  ['i2', 'brighttest --device --no-lease', 'deny'],
  ['i3', 'grep -- --no-lease docs/guide/device-lease.md', 'allow'],
  ['j', `npx rooibos --host ${HOST}`, 'deny'],
  ['j2', 'npx -y rooibos', 'deny'],
  ['j3', 'npm exec rooibos -- --host x', 'deny'],
  ['k1', `telnet ${HOST} 8080`, 'deny'],
  ['k2', `nc ${HOST} 8085`, 'deny'],
  ['k3', `nc -v ${HOST} 22`, 'allow'],
  ['l', `wget http://${HOST}/plugin_install`, 'deny'],
  ['m', `curl -d "" "http://${HOST}:8060/keypress/Home"`, 'deny'],
  ['n', `curl -X POST http://${HOST}:8060/launch/dev`, 'deny'],
  ['o', 'node "$REPO/bin/cli.js" e2e run flows/a.e2e.yaml', 'allow'],
  ['o2', 'node /abs/wt/bin/cli.js studio --host 1.2.3.4', 'allow'],
  ['p', 'npx brighttest e2e run flows/a.e2e.yaml', 'allow'],
  ['p2', './node_modules/.bin/brighttest --cross-check', 'allow'],
  ['q', `curl http://${HOST}:80/plugin_inspect`, 'deny'],
  ['r', `curl http://${HOST}:8090/bsprof/channel.bsprof`, 'deny'],
  ['s', `curl http://${HOST}:8087/`, 'deny'],
  ['t', `websocat ws://${HOST}:8060/`, 'deny'],
  ['u', 'curl -s http://example.com/', 'allow'],
  ['u2', `curl -s http://${HOST}:3000/health`, 'allow'],
  ['v', `echo 'curl -d "" http://${HOST}:8060/keypress/Home' > script.sh`, 'allow'],
  ['v2', `cat <<EOF > run.sh\ncurl -d '' http://${HOST}:8060/keypress/Home\nEOF`, 'deny'], // heredoc body is split as a command: documented conservative
  ['x1', `ls && curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['x2', `ls; curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['x3', `echo go | curl -d @- http://${HOST}:8060/keypress/Home`, 'deny'],
  ['x4', `bash -c "curl -d '' http://${HOST}:8060/keypress/Home"`, 'deny'],
  ['x5', `sudo curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['x6', `timeout 5 curl -d '' http://${HOST}:8060/keypress/Home`, 'deny'],
  ['x7', `echo hi > /dev/tcp/${HOST}/8060`, 'deny'],
  ['x8', `curl -d '' http://192.168.77.5:8060/keypress/Home`, 'deny'], // unregistered host on the ECP port
  ['x9', 'curl -d x http://192.168.77.5:3000/', 'allow'],
  ['y1', '', 'allow'],
  ['y2', 'git status', 'allow'],
  ['y3', 'npx rooibos-roku-docs', 'allow'],
  ['y4', `curl -H 'Host: x' http://${HOST}:8060/keypress/Home --user rokudev:secret`, 'deny'],
]

describe('hook classify table (device-lease 4.9, TP-LSE-21)', () => {
  it('has 40+ cases', () => { expect(TABLE.length).toBeGreaterThanOrEqual(40) })
  for (const [id, cmd, want] of TABLE) {
    it(`${id}: ${want}`, () => {
      const r = classify(cmd, opts)
      expect(r.decision).toBe(want)
      if (want === 'deny') {
        expect(r.reason).toMatch(/brighttest device with|lease/i)
        if (r.rule !== 'no-lease') expect(r.reason).toContain('device with')
      }
    })
  }
  it('raw keypress deny names the brighttest command and echoes no host or secret', () => {
    const r = classify(`curl -d '' --user rokudev:secret http://${HOST}:8060/keypress/Home`, opts)
    expect(r.reason).toContain('brighttest device with --as <you>')
    expect(r.reason).not.toContain(HOST)
    expect(r.reason).not.toContain('secret')
  })
  it('allows everything when no host is known and no ECP port appears', () => {
    expect(classify('curl http://10.0.0.9/x', { hosts: [] }).decision).toBe('allow')
  })
})

describe('hook main (stdin to stdout, always exit 0)', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hook-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const env = (extra = {}) => ({ BRIGHTTEST_LEASE_DIR: dir, ROKU_HOST: HOST, BRIGHTTEST_CACHE: path.join(dir, 'none.json'), ...extra })
  const run = async (input, e = env(), stdinStream) => {
    let out = ''
    const stdout = new Writable({ write(c, _e, cb) { out += c; cb() } })
    const stdin = stdinStream || Readable.from([typeof input === 'string' ? input : JSON.stringify(input)])
    const code = await main({ stdin, stdout, env: e })
    return { code, out }
  }
  const payload = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: dir, session_id: 'sess-1', ...extra })
  const events = () => lease.createStore({ dir, env: {} }).readEvents({ key: HOST })

  it('allows with no output', async () => {
    const r = await run(payload('ls'))
    expect(r).toEqual({ code: 0, out: '' })
  })
  it('denies with the section 4.9 JSON shape and logs hook-deny with session_id, redacted', async () => {
    const r = await run(payload(`curl -u rokudev:hunter2 -d '' http://${HOST}:8060/keypress/Home`))
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(j.hookSpecificOutput.permissionDecisionReason).toContain('brighttest device with')
    const ev = events().find((e) => e.ev === 'hook-deny')
    expect(ev.sessionId).toBe('sess-1')
    expect(JSON.stringify(ev)).not.toContain('hunter2')
  })
  it('ignores non-Bash tools and non-string commands', async () => {
    expect((await run({ tool_name: 'Read', tool_input: { file_path: 'x' } })).out).toBe('')
    expect((await run({ tool_name: 'Bash', tool_input: {} })).out).toBe('')
  })
  it('fails open on malformed stdin and notes it', async () => {
    const r = await run('not json')
    expect(r).toEqual({ code: 0, out: '' })
    expect(events().some((e) => e.ev === 'note' && /malformed/.test(e.note))).toBe(true)
  })
  it('fails open on empty stdin', async () => { expect(await run('')).toEqual({ code: 0, out: '' }) })
  it('fails open when stdin never closes (watchdog) and notes it', async () => {
    const hang = new Readable({ read() {} })
    const r = await run(null, env({ BRIGHTTEST_HOOK_TIMEOUT_MS: '100' }), hang)
    expect(r).toEqual({ code: 0, out: '' })
    expect(events().some((e) => /timeout/.test(e.note || ''))).toBe(true)
  })
  it('fails open when classification is slower than the budget (test delay hook)', async () => {
    const r = await run(payload(`curl -d '' http://${HOST}:8060/keypress/Home`), env({ BRIGHTTEST_HOOK_TIMEOUT_MS: '100', BRIGHTTEST_HOOK_TEST_DELAY_MS: '600' }))
    expect(r).toEqual({ code: 0, out: '' })
  })
  it('fails open on an internal crash', async () => {
    const r = await main({ stdin: null, stdout: { write() { throw new Error('boom') } }, env: env() })
    expect(r).toBe(0)
  })
  it('allows a raw call carrying the token of a live lease, denies once it is released', async () => {
    const l = await lease.acquire({ key: HOST, dir, env: {}, timers: false, waitMs: 0, identity: { worktree: '/tmp/wt', branch: 'b' }, purpose: 'hook test' })
    const cmd = (t) => `BRIGHTTEST_LEASE=${t} curl -d '' http://${HOST}:8060/keypress/Home`
    try {
      expect((await run(payload(cmd(l.leaseId)))).out).toBe('')
      expect(JSON.parse((await run(payload(cmd(EXPIRED)))).out).hookSpecificOutput.permissionDecision).toBe('deny')
    } finally { await l.release() }
    expect(JSON.parse((await run(payload(cmd(l.leaseId)))).out).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  it('reads hosts from the project .env', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ROKU_HOST=10.9.8.7\n')
    const r = await run(payload("curl -d '' http://10.9.8.7:8080/x"), env({ ROKU_HOST: '' }))
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('brighttest device hook (CLI)', () => {
  it('prints deny JSON for a raw keypress and nothing for ls, exit 0', async () => {
    const { spawnSync } = await import('node:child_process')
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hook-cli-'))
    const env = { ...process.env, BRIGHTTEST_LEASE_DIR: d, ROKU_HOST: HOST, BRIGHTTEST_CACHE: path.join(d, 'c.json') }
    const call = (command) => spawnSync('node', [path.resolve('bin/cli.js'), 'device', 'hook'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: d, session_id: 's' }), env, encoding: 'utf8' })
    const bad = call(`curl -d '' http://${HOST}:8060/keypress/Home`)
    expect(bad.status).toBe(0)
    expect(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    const ok = call('ls')
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe('')
    fs.rmSync(d, { recursive: true, force: true })
  })
})

// ENG-HOOK-VARIABLE-HOST: URLs whose host is an environment variable.
const VAR_TABLE = [
  ['v1', 'curl -s -X POST http://$ROKU_HOST/keypress/Home', 'deny'],
  ['v2', 'curl -X POST http://$ROKU_HOST:8060/keypress/Home', 'deny'],
  ['v3', 'curl -d "" "http://${ROKU_HOST}:8060/launch/dev"', 'deny'],
  ['v4', 'curl -d "" "http://${ROKU_HOST:-192.168.1.5}:8060/launch/dev"', 'deny'],
  ['v5', 'curl -s -X POST "http://$ROKU_IP/keypress/Home"', 'deny'],
  ['v6', 'curl --url http://$DEVICE_HOST/keypress/Home -d x', 'deny'],
  ['v7', 'curl http://$ROKU_ADDR:$ROKU_PORT/install -F a=@x.zip', 'deny'],
  ['v8', 'wget --post-data= http://$HOST/keypress/Home', 'deny'],
  ['v9', 'http POST $ROKU_HOST:8060/keypress/Home', 'deny'],
  ['v10', 'sh -c "curl -X POST http://$ROKU_HOST/keypress/Home"', 'deny'],
  ['v11', "bash -c 'curl -X POST http://${ROKU_HOST}:8060/keypress/Home'", 'deny'],
  ['v12', 'ls && curl -X POST http://$ROKU_HOST/keypress/Home', 'deny'],
  ['v13', 'ls; curl -X POST http://$ROKU_HOST/keypress/Home', 'deny'],
  ['v14', 'echo go | curl -d @- http://$ROKU_HOST/keypress/Home', 'deny'],
  ['v15', 'x=$(curl -X POST http://$ROKU_HOST/keypress/Home)', 'deny'],
  ['v16', 'echo "$(curl -X POST http://$ROKU_HOST/keypress/Home)"', 'deny'],
  ['v17', 'echo `curl -X POST http://$ROKU_HOST/keypress/Home`', 'deny'],
  ['v18', 'curl http://$ROKU_HOST:8060/query/icon/12', 'deny'],
  ['v19', 'curl -X POST http://$ROKU_HOST:8060/query/device-info', 'deny'],
  ['v20', 'brighttest device with --as dev#1 --purpose x -- curl -X POST http://$ROKU_HOST/keypress/Home', 'allow'],
  ['v21', 'brighttest device with --as dev#1 --purpose x -- sh -c "curl -X POST http://$ROKU_HOST/keypress/Home"', 'allow'],
  ['v22', 'brighttest device with --as dev#1 --purpose x -- true && curl -X POST http://$ROKU_HOST/keypress/Home', 'deny'],
  ['v23', 'brighttest device with --as dev#1 --purpose x -- true; curl -X POST http://$ROKU_HOST/keypress/Home', 'deny'],
  ['v24', `BRIGHTTEST_LEASE=${VALID} curl -X POST http://$ROKU_HOST/keypress/Home`, 'allow'],
  ['u1', 'echo $ROKU_HOST', 'allow'],
  ['u2', 'curl https://example.com/$PATH_VAR', 'allow'],
  ['u3', 'curl http://localhost:3000/keypress', 'allow'],
  ['u4', 'curl http://$API_HOST/health', 'allow'],
  ['u5', 'curl -X POST http://$API_HOST:3000/keypress/Home', 'allow'],
  ['u6', 'curl http://example.com/$X/keypress/Home', 'allow'],
  ['u7', "echo '$(curl -X POST http://$ROKU_HOST/keypress/Home)'", 'allow'],
  ['r1', 'curl http://$ROKU_HOST:8060/query/device-info', 'allow'], // read-only /query stays allowed
  ['r2', 'curl "http://${ROKU_HOST}:8060/query/apps"', 'allow'],
]

describe('hook classify: host is an environment variable', () => {
  for (const [id, cmd, want] of VAR_TABLE) {
    it(`${id} ${want}: ${cmd.slice(0, 70).replace(/\n/g, ' ')}`, () => {
      expect(classify(cmd, opts).decision).toBe(want)
    })
  }
  it('works with no registered hosts', () => {
    expect(classify('curl -X POST http://$ROKU_HOST/keypress/Home', { hosts: [] }).decision).toBe('deny')
  })
  it('extractSubstitutions skips single quotes and handles nesting', () => {
    const { extractSubstitutions } = hook
    expect(extractSubstitutions("echo '$(a)' \"$(b $(c))\" `d`")).toEqual(['b $(c)', 'c', 'd'])
  })
  it('malformed or odd input does not throw', () => {
    for (const c of ['$(', '`', 'curl http://${', 'curl http://$', "echo '$(", undefined, null, 42]) {
      expect(() => classify(c, opts)).not.toThrow()
    }
  })
})
