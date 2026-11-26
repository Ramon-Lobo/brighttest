import { describe, it, expect } from 'vitest'

const load = () => import('../lib/studio/web/src/lib/nodestate.js')

describe('Node State helpers', () => {
  it('flattens a read into rows: node refs and markers are leaves, redacted and null are read only', async () => {
    const { rowsOfNode } = await load()
    const rows = rowsOfNode({ title: 'Home', count: 3, on: true, empty: null, token: '<redacted:token>', deep: '$truncated:depth', kind: '$type:roFunction',
      owner: { $node: 'hero', subtype: 'Poster' }, list: ['a', { b: 1 }], sub: { x: 1 } })
    const by = (k) => rows.find((r) => r.key === k)
    expect(by('title')).toMatchObject({ path: 'title', kind: 'value', type: 'string', editable: true })
    expect(by('count')).toMatchObject({ type: 'number', editable: true })
    expect(by('empty')).toMatchObject({ type: 'null', editable: false })
    expect(by('token')).toMatchObject({ kind: 'redacted', editable: false })
    expect(by('deep')).toMatchObject({ kind: 'marker', load: true, editable: false })
    expect(by('kind')).toMatchObject({ kind: 'marker', load: false })
    expect(by('owner')).toMatchObject({ kind: 'node', id: 'hero', subtype: 'Poster', branch: false, editable: false })
    expect(rows.filter((r) => r.path.startsWith('owner.'))).toEqual([])
    expect(by('list')).toMatchObject({ branch: true, badge: '[2]' })
    expect(rows.find((r) => r.path === 'list.1.b')).toMatchObject({ depth: 2, editable: true })
    expect(rows.find((r) => r.path === 'sub.x')).toMatchObject({ depth: 1 })
  })

  it('keeps the field type when parsing an edit', async () => {
    const { parseEdit } = await load()
    expect(parseEdit('123', 'string')).toEqual({ ok: true, value: '123' })
    expect(parseEdit('12', 'number')).toEqual({ ok: true, value: 12 })
    expect(parseEdit('', 'number').ok).toBe(false)
    expect(parseEdit('true', 'boolean')).toEqual({ ok: true, value: true })
    expect(parseEdit('yes', 'boolean').ok).toBe(false)
  })

  it('maps refusals to a hint and splits the agent error text', async () => {
    const { refusalText, splitError, refusalHint } = await load()
    expect(splitError('TYPE_MISMATCH: title holds a string; got a number')).toEqual({ code: 'TYPE_MISMATCH', message: 'title holds a string; got a number' })
    expect(splitError('plain')).toEqual({ code: '', message: 'plain' })
    expect(refusalText('FIELD_NOT_FOUND: no field zz on that node')).toMatch(/^FIELD_NOT_FOUND - no field zz on that node - No such field/)
    for (const c of ['FIELD_NOT_FOUND', 'TYPE_MISMATCH', 'PATH_UNDER_NODE', 'M_NOT_AVAILABLE', 'M_PATH_FORBIDDEN', 'NODE_NOT_FOUND', 'REDACTED_VALUE', 'STATE_TOO_LARGE']) expect(refusalHint(c)).not.toBe('')
  })

  it('turns a failed read into a reason, never silence', async () => {
    const { readFailure } = await load()
    expect(readFailure({ status: 423, error: 'held' })).toMatchObject({ kind: 'locked' })
    expect(readFailure({ status: 503, error: '  ' })).toMatchObject({ kind: 'nohub' })
    expect(readFailure({ status: 503, error: 'hub token is not set', code: 'NO_HUB' }).text).toBe('hub token is not set')
    expect(readFailure({ status: 409, code: 'STATE_NOT_INSTRUMENTED', error: 'x' })).toMatchObject({ kind: 'noagent' })
    expect(readFailure({ status: 413, code: 'STATE_TOO_LARGE' })).toMatchObject({ kind: 'large', text: 'Over 64 KB at the current caps.' })
    expect(readFailure({ status: 404, code: 'NODE_NOT_FOUND', error: 'no node hero' }).kind).toBe('gone')
    expect(readFailure({ status: 409, code: 'M_NOT_AVAILABLE', error: 'built-in' }).text).toMatch(/no `m`/)
    expect(readFailure({ status: 504, code: 'ACK_TIMEOUT', error: 'slow' }).text).toMatch(/ACK_TIMEOUT/)
  })

  it('counts duplicate ids and finds a link target', async () => {
    const { dupCount, nodeByIdPath, dupText, effectiveId } = await load()
    const nodes = [{ id: 'a', path: '0' }, { id: 'b', path: '0/1' }, { id: 'a', path: '0/2' }, { path: '0/3' }]
    expect(dupCount(nodes, 'a')).toBe(2)
    expect(dupCount(nodes, 'b')).toBe(1)
    expect(dupCount(nodes, '')).toBe(0)
    expect(nodeByIdPath(nodes, 'a')).toBe('0')
    expect(nodeByIdPath(nodes, 'zz')).toBe(null)
    expect(dupText(2, 'a')).toMatch(/^2 nodes have id a; the agent reads the first one/)
    expect(effectiveId({ id: 'x' }, 'typed')).toBe('x')
    expect(effectiveId({}, 'typed')).toBe('')
    expect(effectiveId(null, ' typed ')).toBe('typed')
  })

  it('splices a loaded sub-path and finds a node reference on a path', async () => {
    const { setAt, nodeRefOnPath } = await load()
    const v = { a: { b: '$truncated:depth' }, list: [1, 2] }
    expect(setAt(v, 'a.b', { c: 1 })).toEqual({ a: { b: { c: 1 } }, list: [1, 2] })
    expect(v.a.b).toBe('$truncated:depth')
    expect(setAt(v, 'list.1', 9).list).toEqual([1, 9])
    expect(setAt(v, '', 5)).toBe(5)
    const t = { child: { $node: 'kid', subtype: 'Label' }, plain: { x: 1 } }
    expect(nodeRefOnPath(t, 'child.text')).toBe('kid')
    expect(nodeRefOnPath(t, 'plain.x')).toBe(null)
  })

  it('offers + assert only for node fields that are ECP attrs', async () => {
    const { assertLine } = await load()
    const node = { id: 'hero', subtype: 'Label', attrs: { visible: 'true', text: 'Hi' } }
    const row = (path, extra = {}) => ({ path, branch: false, kind: 'value', ...extra })
    expect(assertLine(node, 'node', row('visible'))).toBe('- assertField: { id: hero, field: visible, equals: "true" }')
    expect(assertLine(node, 'node', row('opacity'))).toBe(null)
    expect(assertLine(node, 'm', row('visible'))).toBe(null)
    expect(assertLine(node, 'node', row('visible', { kind: 'marker' }))).toBe(null)
    expect(assertLine(node, 'node', row('a.visible'))).toBe(null)
  })
})
