import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// STA-SP7-FU: BT_wRegChk (BT_write.brs) error pins, run headless on the fork engine (brs-cli through its js entry).
const brsCli = path.resolve(__dirname, '../node_modules/@ramonlobo/brs-node/bin/brs.cli.js')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source/bt')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')

const CASES = [
  ['empty-section', '""', '"k"'],
  ['empty-key', '"prefs"', '""'],
  ['numeric-section', '5', '"k"'],
  ['invalid-key', '"prefs"', 'invalid'],
  ['not-allowed', '"other"', '"k"'],
  ['allowed', '"prefs"', '"k"'],
  ['allowed-case-insensitive', '"PREFS"', '"k"'],
]

describe('BT_wRegChk errors (STA-SP7-FU)', () => {
  const lines = ['    ctx = { cfg: { registrySections: ["prefs"] } }']
  for (const [name, s, k] of CASES) lines.push(`    r = BT_wRegChk(ctx, ${s}, ${k})`, `    if r = invalid then print "@@${name} none" else print "@@${name} " + FormatJson(r)`)
  lines.push('    r = BT_wRegChk({ cfg: invalid }, "prefs", "k")', '    print "@@no-cfg " + FormatJson(r)')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-wregchk-')), 'chk.brs')
  fs.writeFileSync(file, `${strip('BT_core.brs')}\n${strip('BT_write.brs')}\nsub main()\n${lines.join('\n')}\nend sub\n`)
  let out
  try {
    out = execFileSync(process.execPath, [brsCli, file], { encoding: 'utf8', timeout: 120000 }).split(/\r?\n/)
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }) }
  const get = (n) => { const l = out.find((x) => x.startsWith(`@@${n} `)); return l.slice(n.length + 3) }

  const BAD = '{"error":"BAD_COMMAND: section and key must be non-empty strings","ok":false}'
  const NOT_ALLOWED = '{"error":"REGISTRY_SECTION_NOT_ALLOWED: section is not in instrument.state.registrySections","ok":false}'

  it('BAD_COMMAND for an empty section', () => expect(get('empty-section')).toBe(BAD))
  it('BAD_COMMAND for an empty key', () => expect(get('empty-key')).toBe(BAD))
  it('BAD_COMMAND for a non-string section', () => expect(get('numeric-section')).toBe(BAD))
  it('BAD_COMMAND for an invalid key', () => expect(get('invalid-key')).toBe(BAD))
  it('REGISTRY_SECTION_NOT_ALLOWED for a section outside the list', () => expect(get('not-allowed')).toBe(NOT_ALLOWED))
  it('REGISTRY_SECTION_NOT_ALLOWED when no registrySections are configured', () => expect(get('no-cfg')).toBe(NOT_ALLOWED))
  it('allowed sections pass, matched case-insensitively', () => {
    expect(get('allowed')).toBe('none')
    expect(get('allowed-case-insensitive')).toBe('none')
  })
})
