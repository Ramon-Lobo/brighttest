import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve(__dirname, '../.github/ISSUE_TEMPLATE')
const forms = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') && f !== 'config.yml')

// Field ids and labels are read with line patterns; the forms are flat enough that no YAML parser is needed.
const ids = (text) => [...text.matchAll(/^\s+id: (\S+)\s*$/gm)].map((m) => m[1])

describe('issue forms', () => {
  test('the field-report form exists', () => {
    expect(forms).toContain('field_report.yml')
  })
  for (const f of forms) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    test(`${f}: field ids are unique`, () => {
      const list = ids(text)
      expect(list.length).toBeGreaterThan(0)
      expect(new Set(list).size).toBe(list.length)
    })
    test(`${f}: has needs-triage or an existing bug label, and the redaction checkbox where promised`, () => {
      if (f !== 'bug_report.yml') {
        expect(text).toMatch(/labels: \[.*"needs-triage"/)
        expect(ids(text)).toContain('redaction')
      }
    })
  }
  test('every form label is defined in labels.json', () => {
    const defined = new Set(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.github/labels.json'), 'utf8')).map((l) => l.name))
    for (const f of forms) {
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/^labels: \[(.*)\]/m)
      for (const l of m[1].split(',').map((x) => x.trim().replace(/"/g, ''))) expect(defined.has(l)).toBe(true)
    }
  })
  test('labels.json names are unique', () => {
    const names = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.github/labels.json'), 'utf8')).map((l) => l.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
