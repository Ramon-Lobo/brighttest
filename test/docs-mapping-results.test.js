import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const m = require('../scripts/docs-mapping-results.js')

describe('published mapping results', () => {
  for (const app of m.APPS) {
    it(`${app}: the committed report equals a fresh render of the example app`, () => {
      const committed = fs.readFileSync(m.outFile(app))
      const fresh = m.renderApp(app)
      // Run `npm run docs:mapping-results` and commit the result when this fails.
      expect(committed.equals(fresh)).toBe(true)
      expect(fresh.toString()).toContain("default-src &#39;none&#39;")
    })
  }

  it('the docs page links each report relative to the site base', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'docs', 'guide', 'mapping-results.md'), 'utf8')
    for (const app of m.APPS) expect(page).toContain(`(../mapping-results/${app}/index.html)`)
  })
})
