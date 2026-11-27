import { describe, test, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { fingerprintOf } = require('../lib/issue')

const body = (area, actual) => `### Summary\nx\n\n### Area\n${area}\n\n### Actual behavior\n${actual}\n`

describe('issue fingerprint', () => {
  test('shape bt-xxxxxxxx and stable for the same input', () => {
    const t = body('Device', 'Error: lease busy (exit 75)')
    expect(fingerprintOf(t)).toMatch(/^bt-[0-9a-f]{8}$/)
    expect(fingerprintOf(t)).toBe(fingerprintOf(t))
  })
  test('numbers, quoted strings and placeholders do not change it', () => {
    expect(fingerprintOf(body('Device', 'Error: no device at <ip-1> after 30 s'))).toBe(fingerprintOf(body('Device', 'Error: no device at <ip-2> after 45 s')))
  })
  test('area and message do change it', () => {
    const a = fingerprintOf(body('Device', 'Error: lease busy'))
    expect(fingerprintOf(body('Studio', 'Error: lease busy'))).not.toBe(a)
    expect(fingerprintOf(body('Device', 'Error: lease lost'))).not.toBe(a)
  })
  test('a plain text falls back to its first non-empty line', () => {
    expect(fingerprintOf('\nboom happened\nmore')).toMatch(/^bt-[0-9a-f]{8}$/)
  })
})
