import { describe, it, expect } from 'vitest'

const load = async () => ({
  ...(await import('../lib/studio/web/src/lib/netdetail.js')),
  ...(await import('../lib/studio/web/src/lib/drag.js')),
})
const b64 = (s) => Buffer.from(s).toString('base64')

describe('network details: layout and prefs', () => {
  it('is side by side from 720 px, stacked below, and the override wins', async () => {
    const { pickOrient } = await load()
    expect(pickOrient(720, null)).toBe('side')
    expect(pickOrient(719, null)).toBe('stacked')
    expect(pickOrient(1200, 'stacked')).toBe('stacked')
    expect(pickOrient(300, 'side')).toBe('side')
    expect(pickOrient(300, 'bogus')).toBe('stacked')
  })
  it('round-trips the remembered split and falls back on bad data', async () => {
    const { readPrefs, writePrefs } = await load()
    expect(readPrefs(writePrefs({ orient: 'side', size: 42.46 }))).toEqual({ orient: 'side', size: 42.5 })
    expect(readPrefs(null)).toEqual({ orient: null, size: 50 })
    expect(readPrefs('{"v":2}')).toEqual({ orient: null, size: 50 })
    expect(readPrefs('{"v":1,"orient":"x","size":500}')).toEqual({ orient: null, size: 90 })
  })
  it('moves the selection with Up and Down and stops at the ends', async () => {
    const { stepSelection } = await load()
    const ids = ['a', 'b', 'c']
    expect(stepSelection(ids, 'a', 1)).toBe('b')
    expect(stepSelection(ids, 'c', 1)).toBe('c')
    expect(stepSelection(ids, 'a', -1)).toBe('a')
    expect(stepSelection(ids, null, 1)).toBe('a')
    expect(stepSelection(ids, 'gone', -1)).toBe('c')
    expect(stepSelection([], 'a', 1)).toBe(null)
  })
})

describe('splitter maths (drag.js)', () => {
  it('keeps the list at 30 percent and 160 px and the details at 280 px', async () => {
    const { splitLimits } = await load()
    expect(splitLimits(1000, 160, 280, 30)).toEqual({ min: 30, max: 72 })
    const small = splitLimits(400, 160, 280, 30) // both cannot hold: the first pane's minimum wins
    expect(small.min).toBe(40)
    expect(small.max).toBe(40)
    expect(splitLimits(0, 160, 280, 30)).toEqual({ min: 0, max: 100 })
  })
  it('moves 5 percent per arrow along the axis, Home and End go to the limits, other keys are ignored', async () => {
    const { splitKey, clampPct } = await load()
    const lim = { min: 30, max: 70 }
    expect(splitKey('ArrowRight', 50, lim)).toBe(55)
    expect(splitKey('ArrowLeft', 50, lim)).toBe(45)
    expect(splitKey('ArrowLeft', 32, lim)).toBe(30)
    expect(splitKey('ArrowDown', 50, lim)).toBe(null)
    expect(splitKey('ArrowDown', 50, lim, true)).toBe(55)
    expect(splitKey('ArrowUp', 50, lim, true)).toBe(45)
    expect(splitKey('Home', 50, lim)).toBe(30)
    expect(splitKey('End', 50, lim)).toBe(70)
    expect(splitKey('a', 50, lim)).toBe(null)
    expect(clampPct(NaN, lim)).toBe(50)
  })
  it('turns pointer travel into a percentage', async () => {
    const { pctFromPointer } = await load()
    expect(pctFromPointer(600, 100, 1000)).toBe(50)
    expect(pctFromPointer(5, 0, 0)).toBe(50)
  })
})

describe('network details: General block', () => {
  it('lists the HAR membership, redaction state and sizes', async () => {
    const { notInHarText, redactionText, generalRows, statusLine, formatBytes } = await load()
    expect(notInHarText({ inHar: true })).toBe(null)
    expect(notInHarText({ inHar: false, status: null, error: null, synthetic: false })).toBe('pending')
    expect(notInHarText({ inHar: false, status: 403, synthetic: true })).toMatch(/^Not in HAR export: brighttest answered/)
    expect(redactionText({ raw: false })).toBe('redacted')
    expect(redactionText({ raw: true })).toBe('raw: secrets shown')
    expect(statusLine({ status: 200, statusText: 'OK' })).toBe('200 OK')
    expect(statusLine({ status: null, error: 'timeout' })).toBe('error: timeout')
    expect(statusLine({ status: null })).toBe('pending')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3.2 * 1024 * 1024)).toBe('3.2 MB')
    const rows = generalRows({ method: 'GET', url: 'u', status: 200, statusText: 'OK', source: 'mock', rule: null, error: null,
      timings: { wait: 1, receive: 2, total: 3 }, request: { body: { bytes: 0 } }, response: { body: { bytes: 2048 } } })
    expect(Object.fromEntries(rows)).toMatchObject({ Method: 'GET', Status: '200 OK', Source: 'mock', Total: '3 ms', 'Response size': '2.0 KB' })
    expect(Object.fromEntries(rows)).not.toHaveProperty('Rule')
  })
})

describe('network details: body text', () => {
  it('pretty prints JSON that parses and falls back to raw for broken or truncated JSON', async () => {
    const { bodyText } = await load()
    const v = { kind: 'json', text: '{"a":[1,2],"b":"x"}', truncated: false }
    expect(bodyText(v, 'pretty')).toMatchObject({ pretty: true, canPretty: true })
    expect(bodyText(v, 'pretty').text).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": "x"\n}')
    expect(bodyText(v, 'raw')).toEqual({ text: v.text, pretty: false, canPretty: true })
    expect(bodyText({ kind: 'json', text: '{"a":', truncated: false }, 'pretty')).toMatchObject({ pretty: false, canPretty: false })
    expect(bodyText({ ...v, truncated: true }, 'pretty').canPretty).toBe(false)
    expect(bodyText({ kind: 'text', text: 'hello' }, 'pretty')).toEqual({ text: 'hello', pretty: false, canPretty: false })
    expect(bodyText({ kind: 'binary', encoding: 'base64', text: 'AAA=' }, 'raw').text).toBe('')
  })
  it('renders at most 256 KB until asked for all', async () => {
    const { renderSlice, RENDER_MAX } = await load()
    const big = 'x'.repeat(RENDER_MAX + 10)
    expect(renderSlice(big, false)).toEqual({ text: 'x'.repeat(RENDER_MAX), cut: true })
    expect(renderSlice(big, true).cut).toBe(false)
    expect(renderSlice('small', false)).toEqual({ text: 'small', cut: false })
  })
  it('words the truncation, capture, not-captured, decoded and too-large notices', async () => {
    const { bodyNotices } = await load()
    expect(bodyNotices({ kind: 'text', truncated: true, shownBytes: 1024 * 1024, bytes: 3.2 * 1024 * 1024 })).toEqual(['Showing 1.0 MB of 3.2 MB (download for all)'])
    expect(bodyNotices({ kind: 'text', captureTruncated: true })).toEqual(['Capture stopped at 32 MB (the app received more)'])
    expect(bodyNotices({ kind: 'none', reason: 'too-large' })).toEqual(['Request body over 16 MB: not captured'])
    expect(bodyNotices({ kind: 'none', reason: 'pending' })).toEqual(['No response yet'])
    expect(bodyNotices({ kind: 'json', decodedFrom: 'gzip' })).toEqual(['decoded from gzip'])
    expect(bodyNotices({ kind: 'json' })).toEqual([])
  })
  it('dumps the first 512 bytes of a binary body as hex and ASCII', async () => {
    const { hexDump } = await load()
    const dump = hexDump(b64('ABC\x00\xff'))
    expect(dump.startsWith('000000  41 42 43 00 c3 bf')).toBe(true)
    expect(dump.endsWith('  ABC...')).toBe(true)
    const long = hexDump(Buffer.alloc(2000, 0x61).toString('base64'))
    expect(long.split('\n')).toHaveLength(32)
  })
  it('parses form bodies and query strings', async () => {
    const { formPairs, queryPairs } = await load()
    expect(formPairs('a=1&b=x%20y', 'application/x-www-form-urlencoded')).toEqual([['a', '1'], ['b', 'x y']])
    expect(formPairs('a=1', 'application/json')).toEqual([])
    expect(queryPairs('https://h.example.test/p?x=1&y=2')).toEqual([['x', '1'], ['y', '2']])
    expect(queryPairs('not a url')).toEqual([])
  })
})

describe('network details: search and colour', () => {
  it('finds plain-text matches, case-insensitive unless asked, and ignores empty queries', async () => {
    const { findMatches } = await load()
    expect(findMatches('Hero hero HERO', 'hero')).toEqual([0, 5, 10])
    expect(findMatches('Hero hero HERO', 'hero', true)).toEqual([5])
    expect(findMatches('abc', '')).toEqual([])
    expect(findMatches('aaaa', 'aa')).toEqual([0, 2])
    expect(findMatches('a.b', '.')).toEqual([1]) // not a regular expression
  })
  it('splits text around matches and marks the current one', async () => {
    const { segments, findMatches } = await load()
    const t = 'one two one'
    const s = segments(t, findMatches(t, 'one'), 3, 1)
    expect(s.map((x) => x.text).join('')).toBe(t)
    expect(s.filter((x) => x.hit).map((x) => x.cur)).toEqual([false, true])
    expect(segments('abc', [], 1)).toEqual([{ text: 'abc', hit: false, cur: false }])
  })
  it('wraps next and previous', async () => {
    const { nextIndex } = await load()
    expect(nextIndex(0, 3, 1)).toBe(1)
    expect(nextIndex(2, 3, 1)).toBe(0)
    expect(nextIndex(0, 3, -1)).toBe(2)
    expect(nextIndex(-1, 3, 1)).toBe(0)
    expect(nextIndex(-1, 3, -1)).toBe(2)
    expect(nextIndex(0, 0, 1)).toBe(-1)
  })
  it('tokenizes JSON into keys, strings, numbers and literals without losing text', async () => {
    const { jsonTokens } = await load()
    const text = '{\n  "k": "v",\n  "n": -1.5e3,\n  "t": true,\n  "z": null\n}'
    const t = jsonTokens(text)
    expect(t.map((x) => x.text).join('')).toBe(text)
    expect(t.filter((x) => x.cls === 'key').map((x) => x.text)).toEqual(['"k"', '"n"', '"t"', '"z"'])
    expect(t.filter((x) => x.cls === 'str').map((x) => x.text)).toEqual(['"v"'])
    expect(t.filter((x) => x.cls === 'num').map((x) => x.text)).toEqual(['-1.5e3'])
    expect(t.filter((x) => x.cls === 'lit').map((x) => x.text)).toEqual(['true', 'null'])
  })
})
