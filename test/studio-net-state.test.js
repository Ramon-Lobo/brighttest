import { describe, it, expect } from 'vitest'

const load = () => import('../lib/studio/web/src/lib/net-state.js')

describe('Network panel helpers', () => {
  it('shows the server error from a 503 body, else the fixed text', async () => {
    const { noHubMessage, NO_HUB_TEXT } = await load()
    expect(noHubMessage({ error: 'net config: instrument.net.unmatched must be "fail" or "passthrough"', code: 'NO_HUB' }))
      .toBe('net config: instrument.net.unmatched must be "fail" or "passthrough"')
    expect(noHubMessage(null)).toBe(NO_HUB_TEXT)
    expect(noHubMessage({})).toBe(NO_HUB_TEXT)
    expect(noHubMessage({ error: '  ' })).toBe(NO_HUB_TEXT)
    expect(noHubMessage({ error: 5 })).toBe(NO_HUB_TEXT)
  })

  it('derives the selected row by id so a pending row that completes enables Mock this', async () => {
    const { selectedRow, canMock } = await load()
    let rows = [{ id: 'a', bytes: null }]
    expect(canMock(selectedRow(rows, 'a'))).toBe(false)
    rows = [{ id: 'a', bytes: 12 }]
    expect(canMock(selectedRow(rows, 'a'))).toBe(true)
    expect(selectedRow(rows, 'gone')).toBe(null)
    expect(selectedRow(rows, null)).toBe(null)
    expect(canMock(null)).toBe(false)
  })
})
