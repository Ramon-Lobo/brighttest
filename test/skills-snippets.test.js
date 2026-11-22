import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { extractSnippets, validateSnippet, validateSkillSnippets, knownCliFlags } = require('../lib/skills')
const flags = knownCliFlags(fs.readFileSync(path.join(__dirname, '..', 'bin', 'cli.js'), 'utf8'))
const bad = (lang, code) => validateSnippet({ lang, code, line: 1 }, { flags })

describe('skill snippets (AGT-06)', () => {
  test('every snippet in the shipped skills validates', () => {
    const failures = validateSkillSnippets()
    expect(failures.map((f) => `${f.file}:${f.line} [${f.lang}] ${f.problem}`)).toEqual([])
  })

  test('extractSnippets reads lang, body and fence line; flags an unterminated fence', () => {
    const sn = extractSnippets('intro\n```json\n{"a":1}\n```\ntext\n```sh\nls')
    expect(sn[0]).toMatchObject({ lang: 'json', code: '{"a":1}', line: 2 })
    expect(sn[1].unterminated).toBe(true)
    expect(validateSnippet(sn[1])).toEqual(['unterminated code fence'])
  })

  test('json: invalid is caught, property excerpts and elisions pass', () => {
    expect(bad('json', '{"a": }')[0]).toMatch(/invalid JSON/)
    expect(bad('json', '"a": { "b": 1 }')).toEqual([])
    expect(bad('json', '{ "a": ... }')).toEqual([])
  })

  test('yaml: real flow parser rejects an unknown step; fragments and elisions pass', () => {
    expect(bad('yaml', '- launch\n- nonsenseStep: { a: 1 }')[0]).toMatch(/does not parse/)
    expect(bad('yaml', '- launch\n- ...\n- assertVisible: { id: x }')).toEqual([])
    expect(bad('yaml', 'jobs:\n  e2e:\n    runs-on: x')).toEqual([])
  })

  test('shell: syntax errors and unknown brighttest flags are caught; placeholders pass', () => {
    expect(bad('sh', 'if then fi')[0]).toMatch(/shell syntax/)
    expect(bad('sh', 'brighttest --no-such-flag')[0]).toMatch(/unknown CLI flag --no-such-flag/)
    expect(bad('sh', 'brighttest e2e run flows/<name>.e2e.yaml --host <ip> --timeout 5')).toEqual([])
    expect(bad('bash', 'brighttest device with --as "$X" -- npm run --silent foo')).toEqual([])
  })

  test('shell: win32 skips only the bash -n syntax check, the flag check still runs', () => {
    const win = (code) => validateSnippet({ lang: 'sh', code, line: 1 }, { flags, platform: 'win32' })
    expect(win('if then fi')).toEqual([])
    expect(win('brighttest --no-such-flag')[0]).toMatch(/unknown CLI flag --no-such-flag/)
  })

  test('brightscript: unbalanced blocks are caught; anonymous functions and one-liners pass', () => {
    expect(bad('brightscript', 'function f()\n  return 1')[0]).toMatch(/unclosed block/)
    expect(bad('brightscript', 'function f()\n  x = foo(1\nend function')[0]).toMatch(/unbalanced brackets/)
    expect(bad('brightscript', 'sub a()\nend function')[0]).toMatch(/unbalanced block/)
    expect(bad('brightscript', 'function f()\n  o = { g: function() as integer\n    return 1\n  end function }\nend function')).toEqual([])
    expect(bad('brightscript', "function greet(n) : h = 1 : ' ...")).toEqual([])
  })

  test('untagged and unknown fences are ignored', () => {
    expect(bad('', '{{{ not anything')).toEqual([])
    expect(bad('gitignore', '*.zip')).toEqual([])
  })

  test('validateSkillSnippets reports file, line and lang for a bad snippet', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-snip-'))
    try {
      fs.mkdirSync(path.join(root, 'alpha'))
      fs.writeFileSync(path.join(root, 'alpha', 'SKILL.md'), '# x\n\n```json\n{"a":\n```\n')
      const f = validateSkillSnippets(root, '/nonexistent')
      expect(f).toHaveLength(1)
      expect(f[0]).toMatchObject({ file: 'alpha/SKILL.md', line: 3, lang: 'json' })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
