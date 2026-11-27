import { describe, it, expect } from 'vitest'
import { parseValue } from '../lib/studio/web/src/lib/state-edit-value.js'

describe('State edit parseValue, string field', () => {
  it('stores raw text as typed', () => {
    expect(parseValue('abc', 'string')).toEqual({ ok: true, value: 'abc' })
    expect(parseValue('123', 'string')).toEqual({ ok: true, value: '123' })
    expect(parseValue('', 'string')).toEqual({ ok: true, value: '' })
  })
  it('unwraps matching double quotes that parse as a JSON string', () => {
    expect(parseValue('"abc"', 'string')).toEqual({ ok: true, value: 'abc' })
    expect(parseValue('"a \\"b\\""', 'string')).toEqual({ ok: true, value: 'a "b"' })
    expect(parseValue('""', 'string')).toEqual({ ok: true, value: '' })
  })
  it('keeps text that only looks quoted', () => {
    expect(parseValue('"abc', 'string').value).toBe('"abc')
    expect(parseValue('"', 'string').value).toBe('"')
    expect(parseValue('"a"b"', 'string').value).toBe('"a"b"')
    expect(parseValue("'abc'", 'string').value).toBe("'abc'")
  })
})
describe('State edit parseValue, other types unchanged', () => {
  it('number, boolean, fallback', () => {
    expect(parseValue('4', 'number').value).toBe(4)
    expect(parseValue('x', 'number').ok).toBe(false)
    expect(parseValue('true', 'boolean').value).toBe(true)
    expect(parseValue('{"a":1}', 'object').value).toEqual({ a: 1 })
    expect(parseValue('nope', 'object').value).toBe('nope')
  })
})
