import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { suggestSelector, buildAssertion, displayAssertions, appendAssertion } from '../lib/e2e/assert-builder.js'
import { parseFlow } from '../lib/e2e/flow.js'

const node = (o) => ({ subtype: 'Node', id: null, text: null, uri: null, focused: false, ...o })

describe('suggestSelector', () => {
  it('uses the id when it is unique', () => {
    const n = node({ subtype: 'Button', id: 'playButton', text: 'Play' })
    expect(suggestSelector(n, [n])).toMatchObject({ selector: { id: 'playButton' }, count: 1, ambiguous: false })
  })
  it('disambiguates with index when the best selector matches several', () => {
    const a = node({ subtype: 'Poster' })
    const b = node({ subtype: 'Poster' })
    const c = node({ subtype: 'Poster' })
    const r = suggestSelector(b, [a, b, c])
    expect(r).toMatchObject({ selector: { subtype: 'Poster', index: 1 }, count: 3, ambiguous: true, index: 1 })
  })
})

describe('buildAssertion', () => {
  const n = node({ subtype: 'Label', id: 'hdr', text: 'Settings', focused: true })
  const all = [n]
  it('builds each kind from the node state', () => {
    expect(buildAssertion('visible', n, all)).toBe('- assertVisible: { id: hdr }')
    expect(buildAssertion('gone', n, all)).toBe('- assertGone: { id: hdr }')
    expect(buildAssertion('focused', n, all)).toBe('- assertFocused: { id: hdr }')
    expect(buildAssertion('text', n, all)).toBe('- assertText: { id: hdr, equals: Settings }')
  })
  it('quotes text with spaces and rejects text with none / unknown kinds', () => {
    const spaced = node({ id: 'q', text: 'the wire' })
    expect(buildAssertion('text', spaced, [spaced])).toBe('- assertText: { id: q, equals: "the wire" }')
    expect(() => buildAssertion('text', node({ id: 'x' }), [node({ id: 'x' })])).toThrow(/no text/)
    expect(() => buildAssertion('bogus', n, all)).toThrow(/unknown assertion kind/)
  })
})

describe('displayAssertions', () => {
  it('shows visible always; text/focused only when the node supports them', () => {
    const plain = node({ subtype: 'Group', id: 'wrap' })
    expect(displayAssertions(plain, [plain])).toEqual(['- assertVisible: { id: wrap }'])
    const rich = node({ subtype: 'Label', id: 'hdr', text: 'Hi', focused: true })
    expect(displayAssertions(rich, [rich]).map((l) => l.split(':')[0])).toEqual([
      '- assertVisible', '- assertText', '- assertFocused',
    ])
  })
})

describe('appendAssertion', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-')), 'flow.e2e.yaml')

  it('creates a minimal, parseable flow when the file is missing', () => {
    const f = tmp()
    expect(appendAssertion(f, '- assertVisible: { id: homeScreen }', { appId: 'dev' })).toEqual({ created: true })
    const flow = parseFlow(fs.readFileSync(f, 'utf8'))
    expect(flow.appId).toBe('dev')
    expect(flow.steps.map((s) => s.op)).toEqual(['assertVisible'])
    expect(flow.steps[0].selector).toEqual({ id: 'homeScreen' })
  })
  it('appends to an existing flow, keeping earlier steps', () => {
    const f = tmp()
    fs.writeFileSync(f, 'appId: dev\nsteps:\n  - launch\n  - assertVisible: { id: homeScreen }\n')
    expect(appendAssertion(f, '- assertText: { id: hdr, equals: Home }')).toEqual({ created: false })
    const flow = parseFlow(fs.readFileSync(f, 'utf8'))
    expect(flow.steps.map((s) => s.op)).toEqual(['launch', 'assertVisible', 'assertText'])
    expect(flow.steps[2]).toMatchObject({ selector: { id: 'hdr' }, equals: 'Home' })
  })
  it('refuses a file with no steps: block', () => {
    const f = tmp()
    fs.writeFileSync(f, 'appId: dev\n')
    expect(() => appendAssertion(f, '- back')).toThrow(/no "steps:" block/)
  })
})
