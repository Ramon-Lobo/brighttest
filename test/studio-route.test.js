import { describe, it, expect } from 'vitest'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const IDS = ['inspect', 'runs', 'builds', 'record', 'devices', 'profile', 'settings']

describe('Studio hash routes', async () => {
  const { pageFromHash, hashForPage, hashToWrite } = await import(pathToFileURL(path.join(__dirname, '..', 'lib/studio/web/src/lib/route.js')).href)

  it('resolves a direct link to a page id', () => {
    for (const h of ['#/builds', '#builds', '#/builds/', '#/Builds', '#/builds?x=1']) expect(pageFromHash(h, IDS)).toBe('builds')
    for (const id of IDS) expect(pageFromHash(hashForPage(id), IDS)).toBe(id)
  })
  it('ignores empty, unknown and malformed hashes', () => {
    for (const h of ['', '#', '#/', '#/nope', '#/builds/x', '#/../builds', undefined, null]) expect(pageFromHash(h, IDS)).toBeNull()
  })
  it('writes the hash only when it differs, and leaves a bare default page alone', () => {
    expect(hashToWrite('inspect', '')).toBeNull()
    expect(hashToWrite('builds', '')).toBe('#/builds')
    expect(hashToWrite('builds', '#/builds')).toBeNull()
    expect(hashToWrite('runs', '#/builds')).toBe('#/runs')
    expect(hashToWrite('inspect', '#/nope')).toBe('#/inspect')
  })
})
