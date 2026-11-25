import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Structural checks on the release workflows. No YAML dependency: the files use a regular layout (2-space job keys),
// so the text is split per job after dropping comments. `actionlint` covers real syntax.
const ROOT = path.resolve(__dirname, '..')
const read = (f) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

function split(text) {
  const t = stripComments(text)
  const i = t.indexOf('\njobs:\n')
  const head = t.slice(0, i)
  const jobs = {}
  const re = /^ {2}([A-Za-z0-9_-]+):\n/gm
  const body = t.slice(i + 6)
  const marks = [...body.matchAll(re)]
  marks.forEach((m, k) => { jobs[m[1]] = body.slice(m.index, k + 1 < marks.length ? marks[k + 1].index : undefined) })
  return { head, jobs, all: t }
}

const rel = split(read('release.yml'))
const prep = split(read('prepare-release.yml'))
const files = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f))

describe('release.yml', () => {
  it('triggers on v* tag pushes only (plus a rehearsal dispatch)', () => {
    expect(rel.head).toMatch(/push:\n {4}tags: \["v\*"\]/)
    expect(rel.head).not.toMatch(/branches:/)
    expect(rel.head).not.toMatch(/pull_request/)
    expect(rel.head).toMatch(/dry_run:[\s\S]*default: true/)
  })

  it('has no workflow-level permissions and no cancel-in-progress', () => {
    expect(rel.head).toMatch(/^permissions: \{\}$/m)
    expect(rel.head).toMatch(/cancel-in-progress: false/)
    expect(rel.head).toMatch(/group: release-\$\{\{ github\.ref \}\}/)
  })

  it('only publish has the environment and id-token', () => {
    expect(Object.keys(rel.jobs)).toEqual(['verify', 'publish', 'github-release'])
    expect(rel.jobs.publish).toMatch(/environment: npm-release/)
    expect(rel.jobs.publish).toMatch(/id-token: write/)
    expect(rel.jobs.publish).toMatch(/needs: verify/)
    for (const j of ['verify', 'github-release']) {
      expect(rel.jobs[j]).not.toMatch(/id-token/)
      expect(rel.jobs[j]).not.toMatch(/environment:/)
    }
  })

  it('permissions are no broader than stated', () => {
    expect(rel.jobs.verify).toMatch(/permissions:\n {6}contents: read\n/)
    expect(rel.jobs.publish).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write/)
    expect(rel.jobs['github-release']).toMatch(/permissions:\n {6}contents: write[^\n]*\n/)
    expect(rel.all.match(/contents: write/g)).toHaveLength(1)
  })

  it('publish and github-release are skipped on dispatch (rehearsal never stages or releases)', () => {
    expect(rel.jobs.publish).toMatch(/if: github\.event_name == 'push' \|\| inputs\.dry_run/)
    const stage = rel.jobs.publish.split('- name: Stage the package')[1]
    expect(stage).toMatch(/if: github\.event_name == 'push'/)
    const dry = rel.jobs.publish.split('- name: Dry-run stage')[1].split('- name: Stage the package')[0]
    expect(dry).toMatch(/npm stage publish --dry-run/)
    expect(dry).not.toMatch(/secrets\.|NODE_AUTH_TOKEN/)
    expect(rel.jobs['github-release']).toMatch(/if: github\.event_name == 'push'/)
    expect(rel.jobs['github-release']).toMatch(/needs: publish/)
  })

  it('the npm token appears only on the stage step', () => {
    const lines = rel.all.split('\n')
    const hits = lines.map((l, n) => [l, n]).filter(([l]) => /NPM_TOKEN|NODE_AUTH_TOKEN/.test(l))
    expect(hits.length).toBe(1) // one line carries both names; nothing else in the file
    expect(hits[0][0]).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
    const stage = rel.jobs.publish.split('- name: Stage the package')[1]
    expect(stage).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
    expect(stage).toMatch(/npm stage publish/)
    expect(rel.jobs.verify).not.toMatch(/secrets\./)
    expect(rel.jobs['github-release']).not.toMatch(/secrets\./)
  })

  it('stages with an explicit dist-tag and never runs a plain npm publish', () => {
    expect(rel.all).toMatch(/npm stage publish --access public --tag "\$DIST_TAG" --provenance/)
    expect(rel.all).not.toMatch(/npm publish/)
    expect(rel.all).toMatch(/release-check\.js version-ok/)
  })

  it('creates the GitHub Release as a draft on a verified tag', () => {
    const j = rel.jobs['github-release']
    expect(j).toMatch(/gh release create .*--draft/)
    expect(j).toMatch(/--verify-tag/)
    expect(j).toMatch(/DRAFT/)
  })

  it('verify runs the gates', () => {
    for (const s of ['--version-env', 'check --tags', 'release-check.js deps', 'npm run test:unit', 'npm run test:integration', 'release-check.js pack', 'merge-base --is-ancestor', 'npm view "brighttest@$VERSION"']) {
      expect(rel.jobs.verify).toContain(s)
    }
  })
})

describe('prepare-release.yml', () => {
  it('is dispatch only, never tags or publishes, and has no secrets', () => {
    expect(prep.head).toMatch(/workflow_dispatch:/)
    expect(prep.head).not.toMatch(/push:|pull_request/)
    expect(prep.all).not.toMatch(/^\s*git tag|npm publish|npm stage|NPM_TOKEN|NODE_AUTH_TOKEN|id-token/m)
    expect(prep.all).toMatch(/npm version "\$BUMP" --no-git-tag-version/)
    expect(prep.all).toMatch(/npm version "\$BUMP" --preid "\$PREID" --no-git-tag-version/)
    expect(prep.all).toMatch(/npm ci --ignore-scripts/)
    expect(prep.head).toMatch(/^permissions: \{\}$/m)
  })
})

describe('all workflows', () => {
  it('pin third-party actions to full commit SHAs', () => {
    // Scoped to the release workflows; the older docs/test workflows still use tag refs.
    for (const t of [read('release.yml'), read('prepare-release.yml')]) {
      const uses = t.split('\n').filter((x) => /^\s*-?\s*uses:/.test(x))
      expect(uses.length).toBeGreaterThan(0)
      for (const l of uses) expect(l).toMatch(/@[0-9a-f]{40} # v\d/)
    }
  })

  it('never use pull_request_target; npm publish (non-stage) appears nowhere', () => {
    for (const f of files) {
      const t = stripComments(read(f))
      expect(t, f).not.toMatch(/pull_request_target/)
      expect(t, f).not.toMatch(/npm publish/)
    }
  })

  it('only release.yml references the npm secret', () => {
    for (const f of files.filter((x) => x !== 'release.yml')) {
      expect(stripComments(read(f)), f).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/)
    }
  })
})
