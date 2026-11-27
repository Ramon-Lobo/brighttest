import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const R = require('../lib/redact')
const S = require('../lib/redact-sources')

const ctx = (o = {}) => R.createContext({ ci: false, ...o })
const red = (text, o) => R.redact(text, ctx(o))

describe('detectors: positive cases', () => {
  const table = [
    ['known-secret', 'pw is SEEDED-PASSWORD-0001 ok', 'pw is <secret:ROKU_PASSWORD> ok', { knownSecrets: [{ name: 'ROKU_PASSWORD', value: 'SEEDED-PASSWORD-0001' }] }],
    ['known-secret url-encoded', 'q=SEEDED%20PASS%20WORD', 'q=<secret:X>', { knownSecrets: [{ name: 'X', value: 'SEEDED PASS WORD' }] }],
    ['known-secret base64', 'b=' + Buffer.from('SEEDED-PASSWORD-0001').toString('base64'), 'b=<secret:X>', { knownSecrets: [{ name: 'X', value: 'SEEDED-PASSWORD-0001' }] }],
    ['auth-header', 'Authorization: Basic SEEDED0001', 'Authorization: <redacted:header>'],
    ['auth-header cookie', 'Cookie: a=SEEDED0001; b=2', 'Cookie: <redacted:header>'],
    ['auth-header x-roku-reserved', 'x-roku-reserved-dev-id: SEEDED0001', 'x-roku-reserved-dev-id: <redacted:header>'],
    ['auth-header HAR', '{"name":"Set-Cookie","value":"sid=SEEDED0001"}', '{"name":"Set-Cookie","value":"<redacted:header>"}'],
    ['auth-header json', '"authorization": "Bearer SEEDED0001"', '"authorization": "<redacted:header>"'],
    ['cli-secret', 'brighttest run --password SEEDED0001 --host 192.0.2.7:SEEDED0002', 'brighttest run --password *** --host <ip-1>'],
    ['cli-secret equals', '--pass=SEEDED0001 BRIGHTTEST_LEASE=SEEDED0002', '--pass=*** BRIGHTTEST_LEASE=***'],
    ['kv-secret env', 'API_TOKEN=SEEDED0001', 'API_TOKEN=<redacted:API_TOKEN>'],
    ['kv-secret json', '{"password": "SEEDED0001", "n": 1}', '{"password": "<redacted:password>", "n": 1}'],
    ['kv-secret colon', 'session: SEEDED0001', 'session: <redacted:session>'],
    ['kv-secret xml', '<apiToken>SEEDED0001</apiToken>', '<apiToken><redacted:apiToken></apiToken>'],
    ['jwt', 'x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl y', 'x <token> y'],
    ['bearer', 'got Bearer abcDEF123456xyz', 'got Bearer <token>'],
    ['hex32', 'hub 0123456789abcdef0123456789abcdef up', 'hub <hex32> up'],
    ['high-entropy', 'blob aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7nP9rS end', 'blob <token> end'],
    ['url-userinfo', 'https://bob:SEEDED0001@files.example.net/x', 'https://<user>@<host-1>/x'],
    ['url-query', 'GET https://files.example.net/x?sig=SEEDED0001&page=2', 'GET https://<host-1>/x?sig=<redacted>&page=2'],
    ['email', 'mail a.b+c@mail.example.org now', 'mail <email> now'],
    ['device-id xml', '<serial-number>SEEDEDSERIAL0001</serial-number>', '<serial-number><serial></serial-number>'],
    ['device-id kv', 'serial-number: SEEDEDSERIAL0001', 'serial-number: <serial>'],
    ['device-id json', '"udn": "SEEDED-UDN-1"', '"udn": "<device-id>"'],
    ['mac', 'mac B8:3E:59:00:00:01 and b8-3e-59-00-00-02', 'mac <mac> and <mac>'],
    ['ipv4', 'on 192.0.2.5 and 10.1.2.3:8060 again 192.0.2.5', 'on <ip-1> and <ip-2>:8060 again <ip-1>'],
    ['ipv6', 'at fe80::1ff:fe23:4567:890a ok', 'at <ip6-1> ok'],
    ['host url', 'GET https://cdn.example.net/a/b.json', 'GET https://<host-1>/a/b.json'],
    ['host port', 'sideload roku-box.example.net:8060', 'sideload <host-1>:8060'],
    ['host .local', 'found roku-box.local', 'found <host-1>'],
    ['bundle-id', 'id com.examplecorp.sample.tv here', 'id <bundle-id> here'],
    ['deny-term variants', 'Sample Channel sample_channel SAMPLE-CHANNEL SampleChannel', '<name-1> <name-1> <name-1> <name-1>', { denyTerms: ['Sample Channel'] }],
    ['deny-term long substring', 'ExamplecorpTV', '<name-1>TV', { denyTerms: ['Examplecorp'] }],
  ]
  for (const [name, input, expected, o] of table) {
    test(name, () => { expect(red(input, o)).toBe(expected) })
  }
})

describe('detectors: kept text', () => {
  const kept = [
    'version 0.8.0-rc.0', 'engine 2.7.1-bt.1', 'firmware 16.0.4.4116', 'v1.2.3.4', 'pkg@1.2.3.4', 'version: 1.2.3.4',
    'loopback 127.0.0.1 and 0.0.0.0 and 255.255.255.255', 'ip ::1',
    'sha a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'short 3f2a9c1', 'hash ' + 'ab'.repeat(32),
    'BrightScript literal &hFF', 'see source/main.brs:12', 'at 12:34:56 done',
    'https://github.com/example/repo/issues/1', 'https://registry.npmjs.org/pkg', 'http://localhost:8060/query', 'pkg@1.2.3',
    'a normal sentence with the word token inside', 'CamelCaseIdentifierThatIsVeryLongButLowEntropyAAAAAAAA',
    'key: ' + '<redacted:key>', 'file.json:12',
  ]
  for (const k of kept) test(`keeps: ${k}`, () => { expect(red(k)).toBe(k) })
})

describe('paths', () => {
  const o = { projectRoots: ['/work/sample-project', 'C:\\work\\sample-project'], homeDirs: ['/home/devuser-seeded'] }
  test('project paths keep their relative folders', () => {
    expect(red('at /work/sample-project/source/main.brs:12', o)).toBe('at <project>/source/main.brs:12')
    expect(red('at C:\\work\\sample-project\\source\\main.brs:12', o)).toBe('at <project>/source/main.brs:12')
  })
  test('POSIX home directories become ~', () => {
    expect(red('/Users/bob/dev/x/a.js', o)).toBe('~/a.js')
    expect(red('/home/devuser-seeded/.cache/t.json', o)).toBe('~/t.json')
    expect(red('/root/work/a.js', o)).toBe('~/a.js')
    expect(red('open ~/notes/todo.txt', o)).toBe('open ~/todo.txt')
  })
  test('Windows home directories become ~', () => {
    expect(red('C:\\Users\\Bob Smith\\dev\\x\\a.js', o)).toBe('~/a.js')
  })
  test('other absolute paths keep only the file name', () => {
    expect(red('at /opt/tools/lib/engine.js:99', o)).toBe('at <path>/engine.js:99')
  })
  test('the user name never survives', () => {
    expect(red('/Users/bob/x/y/z.txt C:\\Users\\bob\\q.txt', o)).not.toMatch(/bob/)
  })
})

describe('allocator, idempotence, lines', () => {
  test('placeholders are stable across inputs of one call', () => {
    const [a, b] = R.redact(['x 192.0.2.1 y 192.0.2.2', 'z 192.0.2.2'], ctx())
    expect(a).toBe('x <ip-1> y <ip-2>')
    expect(b).toBe('z <ip-2>')
  })
  test('named inputs keep their name', () => {
    const [a] = R.redact([{ name: 'a.txt', text: 'ip 192.0.2.1' }], ctx())
    expect(a).toEqual({ name: 'a.txt', text: 'ip <ip-1>' })
  })
  test('mapping is not part of the result', () => {
    const c = ctx()
    const out = R.redact('192.0.2.1', c)
    expect(JSON.stringify([out, c])).not.toContain('192.0.2.1')
  })
  const sample = [
    'Authorization: Bearer abcdefgh123456', 'ROKU_PASSWORD=SEEDED-PASSWORD-0001', 'https://u:p@host.example.net:8060/a?token=zzz', '/Users/bob/x/y.js',
    '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----', 'Sample Channel on 192.0.2.5 com.sample.channel.tv',
    '<serial-number>S1</serial-number> b8:3e:59:00:00:01', 'x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl',
  ].join('\n')
  const o = { denyTerms: ['Sample Channel'], knownSecrets: [{ name: 'ROKU_PASSWORD', value: 'SEEDED-PASSWORD-0001' }], projectRoots: ['/work/p'], homeDirs: ['/home/x'] }
  test('idempotent', () => {
    const once = red(sample, o)
    expect(red(once, o)).toBe(once)
  })
  test('line count preserved (private key block)', () => {
    expect(red(sample, o).split('\n').length).toBe(sample.split('\n').length)
  })
  test('verify on redacted output is clean', () => {
    expect(R.verify(red(sample, o), ctx(o))).toEqual([])
  })
  test('verify on raw reports kind and line, never values', () => {
    const leaks = R.verify(sample, ctx(o))
    expect(leaks.length).toBeGreaterThan(3)
    for (const l of leaks) expect(Object.keys(l).sort()).toEqual(['kind', 'line'])
    expect(JSON.stringify(leaks)).not.toContain('SEEDED')
  })
})

describe('npm package scope', () => {
  const c = () => ctx({ denyTerms: ['scope', 'Examplecorp'], knownSecrets: [{ name: 'T', value: 'sekrit-value-1' }] })
  test('@scope/name survives, with and without a version', () => {
    expect(R.redact('npm i @scope/name and @scope/name@1.2.3', c())).toBe('npm i @scope/name and @scope/name@1.2.3')
    expect(R.verify('npm i @scope/name', c())).toEqual([])
  })
  test('the same word outside a package spec is still a deny term', () => {
    expect(R.redact('scope and @scope/name', c())).toBe('<name-1> and @scope/name')
  })
  test('a host, token or secret next to or inside a package spec is still redacted', () => {
    expect(R.redact('@scope/name sekrit-value-1', c())).toBe('@scope/name <secret:T>')
    expect(R.redact('@scope/name?token=abc123', c())).toBe('@scope/name?token=<redacted:token>')
    expect(R.redact('@scope.example.test/x', c())).toBe('@<name-1>.example.test/x')
    expect(R.redact('https://scope.example.test/x @scope/name', c())).toBe('https://<host-1>/x @scope/name')
    expect(R.redact('user@scope.example.test', c())).toBe('<email>')
  })
})

describe('Roku model name', () => {
  // A device-cache name can equal the model; the deny-term pass must keep the model and still mask names.
  const c = () => ctx({ denyTerms: ['3960X', 'C020X', 'Examplecorp'], knownSecrets: [{ name: 'T', value: 'sekrit-value-1' }] })
  test('a model line in a collect-style block survives unchanged', () => {
    const block = '- device: 3960X, stb, firmware 12.5.0 (build 4210)\nmodel: 4210X\n"model": "C020X"\nmodel=3960X'
    expect(R.redact(block, c())).toBe(block)
    expect(R.verify(block, c())).toEqual([])
  })
  test('other deny terms next to a model name are still masked', () => {
    expect(R.redact('Examplecorp 3960X and Examplecorp-3960X', c())).toBe('<name-1> 3960X and <name-1>-3960X')
  })
  test('a host and a token next to a model name are still redacted', () => {
    const out = R.redact('model: 3960X host https://box.example.test/x ip 192.0.2.7 token=abc123 sekrit-value-1', c())
    expect(out).toBe('model: 3960X host https://<host-1>/x ip <ip-1> token=<redacted:token> <secret:T>')
  })
})

describe('long lines', () => {
  test('a 1 MB single line redacts in bounded time', () => {
    const shapes = ['a', 'abcdefghij0123456789', 'ab.cd.ef.', 'hello world foo=bar x.y ', 'http://a.b.c/x?y=1 ']
    for (const unit of shapes) {
      const line = unit.repeat(Math.ceil(1048576 / unit.length)).slice(0, 1048576)
      const t0 = Date.now()
      const out = R.redact(line, ctx({ denyTerms: ['Examplecorp'] }))
      expect(Date.now() - t0).toBeLessThan(30000)
      expect(out.includes('\n')).toBe(false)
    }
  }, 120000)
})

describe('deny terms and stop list', () => {
  test('stop-list and short terms are skipped and counted', () => {
    const c = ctx({ denyTerms: ['app', 'Roku', 'ab', 'Examplecorp'] })
    expect(c.denyTerms).toEqual(['Examplecorp'])
    expect(c.skipped.length).toBe(3)
    expect(R.redact('my app on a roku', c)).toBe('my app on a roku')
  })
  test('short deny terms need non-alphanumeric edges', () => {
    const c = ctx({ denyTerms: ['bobby'] })
    expect(R.redact('bobby, bobbyx and Bobby.', c)).toBe('<name-1>, bobbyx and <name-1>.')
  })
  test('url-encoded and base64 forms of a term are masked', () => {
    const c = ctx({ denyTerms: ['Sample Channel'] })
    expect(R.redact('t=Sample%20Channel', c)).toBe('t=<name-1>')
    expect(R.redact('b=' + Buffer.from('Sample Channel').toString('base64'), c)).toBe('b=<name-1>')
  })
})

describe('fingerprint', () => {
  test('same failure on two machines matches, different first lines differ', () => {
    const a = R.fingerprint('e2e', 'Timeout 30000ms waiting for "Home" at /Users/a/x/flows/h.yml:12')
    const b = R.fingerprint('e2e', 'Timeout 45000ms waiting for "Detail" at C:\\Users\\b\\x\\flows\\h.yml:99')
    expect(a).toMatch(/^bt-[0-9a-f]{8}$/)
    expect(a).toBe(b)
    expect(R.fingerprint('e2e', 'Different failure entirely')).not.toBe(a)
    expect(R.fingerprint('net', 'Timeout 30000ms waiting for "Home"')).not.toBe(R.fingerprint('e2e', 'Timeout 30000ms waiting for "Home"'))
  })
})

describe('sources', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bt-redact-'))
  test('known secrets from env and .env, deny terms from manifest, package.json, git config, deny file', () => {
    const dir = tmp(); const home = tmp()
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'ROKU_PASSWORD=SEEDED-PASSWORD-0001\nOTHER_API_KEY="SEEDED-KEY-00000001"\nPLAIN=value-not-secret\n')
      fs.writeFileSync(path.join(dir, 'manifest'), 'title=Seeded Sample Title\nsubtitle=Seeded Subtitle\n')
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@seededorg/seeded-package' }))
      fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@example.test:seededowner/seededrepo.git\n[user]\n\tname = Seeded Person\n')
      fs.mkdirSync(path.join(dir, '.brighttest')); fs.writeFileSync(path.join(dir, '.brighttest', 'issue-deny.txt'), '# names\nSeededClient\n\napp\n')
      fs.mkdirSync(path.join(home, '.brighttest'))
      fs.writeFileSync(path.join(home, '.brighttest', 'devices.json'), JSON.stringify({ lastHost: '192.0.2.77', devices: { '192.0.2.77': { name: 'Seeded Lounge Box', password: 'SEEDED-DEVPW-0001' } } }))
      const { ctx: c, notes } = S.buildContext({ dir, home, env: { BRIGHTTEST_HUB_TOKEN: 'SEEDED-HUB-0001', MY_SECRET_THING: 'short' } })
      const names = c.knownSecrets.map((k) => k.name)
      expect(names).toEqual(expect.arrayContaining(['ROKU_PASSWORD', 'OTHER_API_KEY', 'BRIGHTTEST_HUB_TOKEN', 'DEVICE_PASSWORD', 'DEVICE_HOST']))
      expect(names).not.toContain('PLAIN')
      expect(names).not.toContain('MY_SECRET_THING')
      for (const t of ['Seeded Sample Title', 'Seeded Subtitle', 'seeded-package', 'seededorg', 'seededowner', 'seededrepo', 'Seeded Person', 'SeededClient', 'Seeded Lounge Box']) expect(c.denyTerms).toContain(t)
      expect(c.denyTerms).not.toContain('app')
      expect(notes.skippedTerms).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(notes)).not.toContain('SEEDED')
      const out = R.redact('pw SEEDED-DEVPW-0001 host 192.0.2.77 Seeded Lounge Box', c)
      expect(out).toBe('pw <secret:DEVICE_PASSWORD> host <ip-1> <name-1>')
      // nothing is written next to the project
      expect(fs.readdirSync(dir).sort()).toEqual(['.brighttest', '.env', '.git', 'manifest', 'package.json'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }) }
  })
})

describe('serial forms', () => {
  const cases = [
    'serial: ZZ00AB123456', 'Serial Number: ZZ00AB123456', 'SERIAL NO: ZZ00AB123456', 'serial_number=ZZ00AB123456',
    'serialnumber ZZ00AB123456', 'serial "ZZ00AB123456"', 'Serial Number: "ZZ00AB-123456"', 'serial=ZZ00AB123456',
  ]
  test.each(cases)('masks and flags %s', (line) => {
    const out = red(line)
    expect(out).not.toContain('ZZ00AB')
    expect(out).toContain('<serial>')
    expect(R.verify(line, ctx()).length).toBeGreaterThan(0)
    expect(R.verify(out, ctx())).toEqual([])
    expect(red(out)).toBe(out)
  })
  test('repro from stdin text keeps the line count', () => {
    expect(red('a\nserial: ZZ00AB123456\nb\n')).toBe('a\nserial: <serial>\nb\n')
  })
  test('prose with the word serial stays', () => {
    const prose = 'The serial number is printed on the box. Serial: unknown. serial port 80 opened; serial numbers differ.'
    expect(red(prose)).toBe(prose)
    expect(R.verify(prose, ctx())).toEqual([])
  })
})
