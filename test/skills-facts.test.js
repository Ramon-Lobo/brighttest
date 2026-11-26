import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { collectFacts, renderFacts, factsProblems, scrapeSubcommands, checkShell, check } = require('../lib/skills')

const repo = path.join(__dirname, '..')
let tmp
const p = (...a) => path.join(tmp, ...a)
const read = (rel) => fs.readFileSync(p(rel), 'utf8')
const write = (rel, body) => { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), body) }
const edit = (rel, fn) => write(rel, fn(read(rel)))
const regen = () => write('skills/facts.json', renderFacts(collectFacts(tmp)))
const rule = (n) => factsProblems(tmp).filter((x) => x.startsWith(`rule ${n} `))
const sink = () => ({ buf: '', write(s) { this.buf += s } })
const SKILL = 'skills/writing-rooibos-tests/SKILL.md'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-facts-'))
  for (const f of ['package.json', 'bin/cli.js', 'docs/guide/agent-skills.md']) write(f, fs.readFileSync(path.join(repo, f), 'utf8'))
  fs.cpSync(path.join(repo, 'skills'), p('skills'), { recursive: true })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('facts gate (ADR 0023)', () => {
  test('the committed repo passes every rule', () => {
    expect(factsProblems(repo)).toEqual([])
    expect(check(path.join(repo, 'skills'), sink(), sink())).toBe(0)
  })

  test('facts.json has the design shape', () => {
    const f = JSON.parse(fs.readFileSync(path.join(repo, 'skills', 'facts.json'), 'utf8'))
    expect(f.schema).toBe('brighttest-facts/v1')
    expect(f.exitCodes).toEqual({ buildStrict: 4, leaseBusy: 75, leaseDir: 78, leaseLost: 77, usage: 2, verifyInstrumented: 3 })
    expect(f.deviceIdleTimeoutDefault).toBe(120)
    expect(f.hookPorts).toEqual([8060, 80, 8085, 8080, 8087, 8090])
    expect(f.hubDefaultPort).toBe(8790)
    expect(f.agents).toEqual(['adoption-assessor', 'ci-integrator', 'device-debugger', 'test-author'])
    expect(f.subcommands).toEqual(expect.arrayContaining(['device with', 'e2e inspect', 'instrument census', 'skills install', 'doctor']))
    expect(fs.readFileSync(path.join(repo, 'skills', 'facts.json'), 'utf8')).toBe(renderFacts(f))
  })

  test('rule 1: a renamed flag or a stale facts file is drift', () => {
    expect(rule(1)).toEqual([])
    edit('bin/cli.js', (s) => s.replaceAll("'--purpose'", "'--reason'"))
    expect(rule(1)[0]).toMatch(/facts drift/)
    regen()
    write('skills/facts.json', read('skills/facts.json').replace('"cliVersion"', '"cliVersionX"'))
    expect(rule(1)).toHaveLength(1)
    fs.rmSync(p('skills/facts.json'))
    expect(rule(1)[0]).toMatch(/missing/)
  })

  test('rule 1: skills --check fails on drift and names it', () => {
    edit('bin/cli.js', (s) => s.replaceAll("'--purpose'", "'--reason'"))
    const err = sink()
    expect(check(p('skills'), sink(), err)).toBe(1)
    expect(err.buf).toMatch(/facts drift/)
  })

  test('rule 2: a Node claim that differs from engines.node', () => {
    expect(rule(2)).toEqual([])
    edit(SKILL, (s) => s + '\nRequires Node 20+ to run.\n')
    regen()
    expect(rule(2)[0]).toMatch(/SKILL\.md.*Node 20\+.*nodeMin 22/)
    edit(SKILL, (s) => s.replace('Node 20+', 'Node 22+'))
    expect(rule(2)).toEqual([])
    write('docs/guide/x.md', "- uses: actions/setup-node\n  with:\n    node-version: '18'\n")
    expect(rule(2)[0]).toMatch(/docs\/guide\/x\.md/)
    fs.rmSync(p('docs/guide/x.md'))
    write('README.md', 'Needs node >= 20.\n')
    expect(rule(2)[0]).toMatch(/README\.md/)
  })

  test('rule 3: SKILLS_HELP and the docs table list exactly the skills', () => {
    expect(rule(3)).toEqual([])
    edit('bin/cli.js', (s) => s.replace('writing-rooibos-tests.\n', 'writing-rooibos-tests, ghost-skill.\n'))
    expect(rule(3)[0]).toMatch(/SKILLS_HELP lists/)
    regen()
    edit('docs/guide/agent-skills.md', (s) => s.replace(/^\| `testing-app-state`.*\n/m, ''))
    expect(rule(3).some((x) => /agent-skills\.md/.test(x))).toBe(true)
  })

  test('rule 4: unknown subcommands in shell fences', () => {
    const subs = scrapeSubcommands(read('bin/cli.js'))
    expect(checkShell('brighttest device with -- x', null, 'win32', subs)).toEqual([])
    expect(checkShell('npx brighttest e2e inspect --host 1.2.3.4', null, 'win32', subs)).toEqual([])
    expect(checkShell('brighttest --device --host 1.2.3.4', null, 'win32', subs)).toEqual([])
    expect(checkShell('brighttest device bogus', null, 'win32', subs)[0]).toMatch(/subcommand 'device bogus'/)
    expect(checkShell('brighttest frobnicate --x', null, 'win32', subs)[0]).toMatch(/subcommand 'frobnicate'/)
    edit(SKILL, (s) => s + '\n```sh\nnpx brighttest device frob\n```\n')
    regen()
    expect(rule(4)[0]).toMatch(/SKILL\.md:\d+: unknown CLI subcommand 'device frob'/)
  })

  test('rule 5: exit-code claims must carry their meaning', () => {
    expect(rule(5)).toEqual([])
    edit(SKILL, (s) => s + '\nThe command exits 77 when the device is busy.\n')
    regen()
    expect(rule(5)[0]).toMatch(/exit 77.*leaseLost/)
    edit(SKILL, (s) => s.replace('exits 77 when the device is busy', 'exits 75 when the device is busy'))
    expect(rule(5)).toEqual([])
    edit(SKILL, (s) => s + '\nVerify exits 4 when markers are found.\n')
    expect(rule(5)[0]).toMatch(/exit 4.*buildStrict/)
  })

  test('rule 5: the number must sit next to exit, so other sentences pass', () => {
    edit(SKILL, (s) => s + '\nStep 3 exits the app with Back.\n\nCheck line 4 of the log.\n')
    expect(rule(5)).toEqual([])
  })

  test('rule 6: explicit overrides are not default claims', () => {
    edit(SKILL, (s) => s + '\nUse `--wait 10m` to give up sooner.\n\nSet --hub-port 8791 for the hub, default or not.\n\n```sh\nnpx brighttest device with --wait 60m -- npm test\n```\n')
    expect(rule(6)).toEqual([])
  })

  test('nodeMin does not throw without engines.node', () => {
    edit('package.json', (s) => { const j = JSON.parse(s); delete j.engines; return JSON.stringify(j) })
    expect(() => collectFacts(tmp)).not.toThrow()
  })

  test('rule 3: only the table under the Skill | Teaches header counts', () => {
    edit('docs/guide/agent-skills.md', (s) => s + '\n| `.claude/` | other table |\n\n| Thing | x |\n|---|---|\n| `stray-name` | y |\n')
    expect(rule(3)).toEqual([])
  })

  test('rule 6: lease defaults and the hub port', () => {
    expect(rule(6)).toEqual([])
    edit(SKILL, (s) => s + '\nThe wait defaults to 20m, and a hold is capped at 60m.\n')
    expect(rule(6)).toEqual([])
    edit(SKILL, (s) => s + '\nA command queues with a wait of 60m by default.\n')
    expect(rule(6)[0]).toMatch(/'60m' near 'wait'/)
    edit(SKILL, (s) => s + '\nThe hub listens on default port 8791.\n')
    expect(rule(6).some((x) => /8791.*8790/.test(x))).toBe(true)
  })

  test('rule 7: banned claims', () => {
    expect(rule(7)).toEqual([])
    for (const [text, re] of [
      ['Works on Node 18.', /Node/],
      ['The lease dir is group-writable across users.', /group-writable/],
      ['Select with testId in flows.', /testId/],
      ['Set instrumentExclude in brighttest.json.', /instrumentExclude/],
      ['Pass --no-lease to skip the queue.', /no-lease/],
    ]) {
      write('skills/writing-rooibos-tests/references/banned.md', `${text}\n`)
      expect(rule(7).join('\n')).toMatch(re)
    }
    write('skills/writing-rooibos-tests/references/banned.md', 'Never pass --no-lease.\n')
    expect(rule(7)).toEqual([])
  })

  test('rule 8: size gate', () => {
    expect(rule(8)).toEqual([])
    edit(SKILL, (s) => s + '\nfiller\n'.repeat(20))
    expect(rule(8)[0]).toMatch(/writing-rooibos-tests\/SKILL\.md: \d+ lines, at most 126/)
    fs.cpSync(p('skills/writing-rooibos-tests'), p('skills/brand-new'), { recursive: true })
    edit('skills/brand-new/SKILL.md', (s) => s.replace(/^name: .*$/m, 'name: brand-new') + '\nfiller\n'.repeat(60))
    write('skills/manifest.json', JSON.stringify({ schema: 'brighttest-skills/v1', skills: [...JSON.parse(read('skills/manifest.json')).skills, { name: 'brand-new', files: ['SKILL.md'] }] }))
    regen()
    expect(rule(8).some((x) => /brand-new\/SKILL\.md.*at most 150/.test(x))).toBe(true)
    write('skills/writing-rooibos-tests/references/big.md', 'x\n'.repeat(201))
    expect(rule(8).some((x) => /references\/big\.md: 201 lines, at most 200/.test(x))).toBe(true)
    edit('skills/brand-new/SKILL.md', (s) => s.replace(/^description: .*$/m, 'description: ' + 'd'.repeat(1030)))
    expect(rule(8).some((x) => /description is 1030 chars/.test(x))).toBe(true)
    write('skills/_always-on/safety.md', 'line\n'.repeat(46))
    expect(rule(8).some((x) => /safety\.md/.test(x))).toBe(true)
  })

  test('rule 9: agents', () => {
    const agent = (fm, body) => write('skills/_agents/probe.md', `---\nname: probe\ndescription: probe\n${fm}\n---\n${body}\n`)
    const forbidden = 'Never use --no-lease. Never run device unlock --force.'
    agent('tools: Read, Bash\nskills: writing-rooibos-tests', `Reads code. ${forbidden}`)
    regen()
    expect(JSON.parse(read('skills/facts.json')).agents).toEqual(expect.arrayContaining(['probe']))
    expect(rule(9)).toEqual([])
    agent('tools: Read, Bash\nskills: writing-rooibos-tests, no-such-skill', forbidden)
    expect(rule(9)[0]).toMatch(/skill 'no-such-skill' does not exist/)
    agent('tools: Read, Agent\nskills: writing-rooibos-tests', forbidden)
    expect(rule(9)[0]).toMatch(/must not contain Agent/)
    agent('tools: Read, Bash\nskills: writing-rooibos-tests', 'Runs brighttest device with -- curl.')
    expect(rule(9)[0]).toMatch(/forbidden-actions/)
  })
})
