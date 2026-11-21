import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
const { lintFlow, lint } = require('../lib/e2e/lint.js')
const { parseFlow } = require('../lib/e2e/flow.js')
const { parseE2eArgs } = require('../bin/cli.js')

const flowOf = (sel) => ({ name: 'f', file: 'f.e2e.yaml', ...parseFlow(`steps:\n  - launch\n  - assertVisible: ${sel}\n`) })

describe('e2e lint: subtype Group', () => {
  it('warns with flow name, line and the RenderableNode reason', () => {
    const w = lintFlow(flowOf('{ subtype: Group }'))
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ rule: 'group-subtype', flow: 'f', line: 3 })
    expect(w[0].message).toContain('RenderableNode')
  })
  it('does not warn for other subtypes or ids', () => {
    expect(lintFlow(flowOf('{ subtype: Label }'))).toEqual([])
    expect(lintFlow(flowOf('{ id: hero }'))).toEqual([])
  })
  it('lint() exits 0 on warnings and 1 on an unparsable flow', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lint-'))
    const ok = path.join(d, 'g.e2e.yaml')
    fs.writeFileSync(ok, 'steps:\n  - launch\n  - assertVisible: { subtype: Group }\n')
    const out = []
    expect(lint([ok], (s) => out.push(s))).toBe(0)
    expect(out.join('\n')).toMatch(/warning: g:3 .*RenderableNode/)
    const bad = path.join(d, 'b.e2e.yaml')
    fs.writeFileSync(bad, 'nope: 1\n')
    const err = console.error; console.error = () => {}
    try { expect(lint([bad], () => {})).toBe(1) } finally { console.error = err }
  })
  it('CLI wiring: e2e lint parses and runs without a device', () => {
    expect(parseE2eArgs(['lint', 'a.e2e.yaml'])).toMatchObject({ e2eAction: 'lint', flows: ['a.e2e.yaml'] })
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lint-'))
    const f = path.join(d, 'g.e2e.yaml')
    fs.writeFileSync(f, 'steps:\n  - assertVisible: { subtype: Group }\n')
    const r = spawnSync(process.execPath, [path.join(__dirname, '../bin/cli.js'), 'e2e', 'lint', f], { encoding: 'utf8', timeout: 20000 })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('RenderableNode')
  })
})
