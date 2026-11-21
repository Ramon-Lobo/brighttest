import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { studioStartOptions, parseStudioArgs } = require('../bin/cli')

describe('brighttest studio passes the raw host and password', () => {
  it('without --host the server gets no host, so it never receives a CLI-chosen cached device', () => {
    const o = studioStartOptions(parseStudioArgs([]), { port: 8700 })
    expect(o.host).toBeFalsy()
    expect(o.password).toBeFalsy()
  })
  it('passes --host and --password through untouched', () => {
    const o = studioStartOptions(parseStudioArgs(['--host', '192.0.2.9', '--password', 'x']), { port: 1 })
    expect(o).toMatchObject({ host: '192.0.2.9', password: 'x', port: 1 })
  })
})
