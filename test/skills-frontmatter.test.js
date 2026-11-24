import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(__dirname, '..', 'skills')
const files = [
  ...fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => path.join(root, d.name, 'SKILL.md')),
  ...fs.readdirSync(path.join(root, '_agents')).filter((f) => f.endsWith('.md')).map((f) => path.join(root, '_agents', f)),
]

// parseFrontmatter does not strip quotes and a YAML reader rejects an unquoted ': ' inside a plain scalar, so keep
// descriptions free of it (rephrase, do not quote).
describe('skill and agent frontmatter', () => {
  test.each(files.map((f) => [path.relative(root, f), f]))('%s description has no unquoted ": "', (_n, f) => {
    const m = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)
    expect(m).toBeTruthy()
    const line = m[1].split('\n').find((l) => /^description\s*:/.test(l))
    expect(line).toBeTruthy()
    const value = line.replace(/^description\s*:\s*/, '')
    expect(value).not.toMatch(/^["']/)
    expect(value).not.toContain(': ')
  })
})
