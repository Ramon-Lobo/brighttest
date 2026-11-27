import { describe, test, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { ISSUE_SECTIONS, REQUIRED_SECTIONS, lint } = require('../lib/issue')
const ROOT = path.resolve(__dirname, '..')

// Field labels of the form: the `label:` lines at the field level (6 spaces), not the checkbox options (10 spaces).
const formLabels = (text) => [...text.matchAll(/^ {6}label: (.+?)\s*$/gm)].map((m) => m[1])

describe('issue schema', () => {
  const form = fs.readFileSync(path.join(ROOT, '.github/ISSUE_TEMPLATE/field_report.yml'), 'utf8')
  test('ISSUE_SECTIONS equals the field-report form labels, in order', () => {
    expect(ISSUE_SECTIONS).toEqual(formLabels(form))
  })
  test('REQUIRED_SECTIONS equals the required fields of the form', () => {
    const blocks = form.split(/\n {2}- type: /).slice(1)
    const required = blocks.filter((b) => /required: true/.test(b) && /^ {6}label: /m.test(b)).map((b) => formLabels(b)[0])
    expect(REQUIRED_SECTIONS).toEqual(required.filter((l) => ISSUE_SECTIONS.includes(l)))
  })
  test('the skill issue-format.md headings equal ISSUE_SECTIONS (once the skill exists)', () => {
    const f = path.join(ROOT, 'skills/reporting-a-brighttest-issue/issue-format.md')
    if (!fs.existsSync(f)) return
    const heads = [...fs.readFileSync(f, 'utf8').matchAll(/^### (.+?)\s*$/gm)].map((m) => m[1])
    expect(heads).toEqual(ISSUE_SECTIONS)
  })
  test('a complete body lints clean', () => {
    const body = ISSUE_SECTIONS.map((s) => `### ${s}\n${s === 'Severity' ? 'medium' : s === 'Environment' ? 'brighttest 0.8.0, Node 22' : 'text'}\n`).join('\n')
    expect(lint(body).warnings).toEqual([])
    expect(lint(body).sections).toEqual(ISSUE_SECTIONS)
  })
  test('a plain log gets no structure lint', () => {
    expect(lint('just a log\nline two\n')).toEqual({ sections: [], warnings: [] })
  })
})
