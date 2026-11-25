import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Structural checks on the release workflows. No YAML dependency: the files use a regular layout (2-space keys),
// so the text is parsed by indentation after dropping comments. `actionlint` covers real syntax.
const ROOT = path.resolve(__dirname, '..')
const WF = path.join(ROOT, '.github', 'workflows')
const read = (f) => fs.readFileSync(path.join(WF, f), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
const indentOf = (l) => l.length - l.trimStart().length

// Child lines of `key:` at `indent`, up to the next line indented <= indent. Returns null if absent.
function block(text, key, indent = 0) {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => indentOf(l) === indent && l.trim().replace(/\s+#.*$/, '').startsWith(key + ':'))
  if (i < 0) return null
  const out = []
  for (let n = i + 1; n < lines.length; n++) {
    if (lines[n].trim() !== '' && indentOf(lines[n]) <= indent) break
    out.push(lines[n])
  }
  return out
}
const childKeys = (lines, indent) => lines.filter((l) => l.trim() && indentOf(l) === indent && /^[A-Za-z0-9_-]+:/.test(l.trim())).map((l) => l.trim().split(':')[0])
const norm = (lines) => lines.map((l) => l.trim().replace(/\s+#.*$/, '')).filter(Boolean).join('|')

function parse(file) {
  const text = stripComments(read(file))
  const jobsLines = block(text, 'jobs')
  const jobNames = childKeys(jobsLines, 2)
  const jobs = {}
  for (const j of jobNames) jobs[j] = block(jobsLines.join('\n'), j, 2).join('\n')
  const on = block(text, 'on')
  return { text, on, onKeys: childKeys(on, 2), jobs, jobNames, emptyTopPerms: /^permissions: \{\}$/m.test(text) }
}
// The lines of one step (a `- name:` list item at 6 spaces) up to the next step.
const stepOf = (job, name) => {
  const m = job.split('\n')
  const i = m.findIndex((l) => l.includes(`- name: ${name}`))
  if (i < 0) return null
  const out = [m[i]]
  for (let n = i + 1; n < m.length; n++) { if (/^ {6}- /.test(m[n])) break; out.push(m[n]) }
  return out.join('\n')
}

const rel = parse('release.yml')
const prep = parse('prepare-release.yml')
const touched = ['release.yml', 'prepare-release.yml', 'test.yml']

describe('release.yml', () => {
  it('has exactly the push-tags and dispatch triggers', () => {
    expect(rel.onKeys).toEqual(['push', 'workflow_dispatch'])
    expect(norm(block(rel.on.join('\n'), 'push', 2))).toBe('tags: ["v*"]')
    expect(norm(block(rel.on.join('\n'), 'workflow_dispatch', 2))).toMatch(/^inputs:\|dry_run:/)
    expect(rel.text).not.toMatch(/workflow_run|branches-ignore|tags-ignore|pull_request/)
    expect(rel.text).toMatch(/dry_run:[\s\S]*?default: true/)
  })

  it('has empty top-level permissions and non-cancelling per-tag concurrency', () => {
    expect(rel.emptyTopPerms).toBe(true)
    expect(norm(block(rel.text, 'concurrency'))).toBe('group: release-${{ github.ref }}|cancel-in-progress: false')
  })

  it('has exactly three jobs with exact permission blocks', () => {
    expect(rel.jobNames).toEqual(['verify', 'publish', 'github-release'])
    expect(norm(block(rel.jobs.verify, 'permissions', 4))).toBe('contents: read')
    expect(norm(block(rel.jobs.publish, 'permissions', 4))).toBe('contents: read|id-token: write')
    expect(norm(block(rel.jobs['github-release'], 'permissions', 4))).toBe('contents: write')
    expect(rel.text.match(/id-token/g)).toHaveLength(1)
    expect(rel.text.match(/contents: write/g)).toHaveLength(1)
  })

  it('only publish has the environment and it is npm-release', () => {
    expect(rel.text.match(/environment:/g)).toHaveLength(1)
    expect(rel.jobs.publish).toMatch(/^ {4}environment: npm-release$/m)
    expect(rel.jobs.publish).toMatch(/^ {4}needs: verify$/m)
  })

  it('publish and github-release run on tag pushes only, never on dispatch', () => {
    expect(rel.jobs.publish).toMatch(/^ {4}if: github\.event_name == 'push'$/m)
    expect(rel.jobs['github-release']).toMatch(/^ {4}if: github\.event_name == 'push'$/m)
    expect(rel.jobs['github-release']).toMatch(/^ {4}needs: publish$/m)
    expect(rel.text).not.toMatch(/npm stage[^\n]*--dry-run|--dry-run[^\n]*npm stage/)
  })

  it('the dry_run refusal step is exact', () => {
    const step = stepOf(rel.jobs.verify, 'Refuse a real run from workflow_dispatch')
    expect(step).not.toBeNull()
    expect(step).toMatch(/^ {8}if: github\.event_name == 'workflow_dispatch'$/m)
    expect(step).toMatch(/DRY_RUN: \$\{\{ inputs\.dry_run \}\}/)
    expect(step).toContain('if [ "$DRY_RUN" != "true" ]; then')
    expect(step).toMatch(/\n\s+exit 1\n\s+fi/)
    expect(step).not.toMatch(/continue-on-error|\|\| true/)
  })

  it('secrets appear exactly once: NODE_AUTH_TOKEN on the stage step', () => {
    expect(rel.text.match(/secrets/g)).toHaveLength(1)
    expect(rel.text).not.toMatch(/toJSON|inherit/)
    expect(rel.text.match(/NODE_AUTH_TOKEN|NPM_TOKEN/g)).toHaveLength(2) // one line carries both names
    const stage = stepOf(rel.jobs.publish, 'Stage the package (not live until approved)')
    expect(stage).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
    expect(stage).toMatch(/npm stage publish --ignore-scripts --access public --tag "\$DIST_TAG" --provenance/)
    expect(stage).not.toMatch(/continue-on-error|npm (ci|install|run)\b/)
  })

  it('builds with no credentials before the stage step, and checks the file list hash', () => {
    const build = stepOf(rel.jobs.publish, 'Build Studio, check changelog and tarball (no credentials)')
    expect(build).not.toBeNull()
    expect(build).toMatch(/unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL/)
    expect(build).not.toMatch(/secrets|NODE_AUTH_TOKEN/)
    expect(build).toMatch(/release-check\.js pack-hash/)
    expect(build).toMatch(/release-check\.js pack "\$RUNNER_TEMP\/pack\.json"/)
    expect(build).toMatch(/changelog\.js check --version-env/)
    expect(rel.jobs.publish.indexOf('(no credentials)')).toBeLessThan(rel.jobs.publish.indexOf('Stage the package'))
    // verify checks the tarball (Studio assets and required dirs) and exports the hash publish compares against
    expect(rel.jobs.verify).toMatch(/release-check\.js pack "\$RUNNER_TEMP\/pack\.json"/)
    expect(rel.jobs.verify).toMatch(/file_hash: \$\{\{ steps\.pack\.outputs\.file_hash \}\}/)
  })

  it('never runs a plain npm publish (any spelling)', () => {
    for (const t of [rel.text, prep.text]) expect(t).not.toMatch(/\bnpm\b(?!\s+stage)[^\n]*\bpublish\b/)
    expect(rel.text).toMatch(/release-check\.js version-ok/)
  })

  it('creates the GitHub Release as a draft on a verified tag', () => {
    const j = rel.jobs['github-release']
    expect(j).toMatch(/gh release create .*--draft/)
    expect(j).toMatch(/--verify-tag/)
    expect(j).toMatch(/DRAFT/)
    expect(rel.text.match(/gh release create/g)).toHaveLength(1)
  })

  it('verify runs every gate, fails closed, and the ancestor check can fail the run', () => {
    for (const s of ['--version-env', 'check --tags', 'release-check.js deps', 'npm run test:unit', 'npm run test:integration', 'release-check.js pack ']) {
      expect(rel.jobs.verify).toContain(s)
    }
    expect(rel.jobs.verify).toMatch(/if ! git merge-base --is-ancestor "\$SHA" origin\/main; then\n[^\n]*\n\s+exit 1\n\s+fi/)
    expect(rel.jobs.verify).toMatch(/if \[ "\$REF_NAME" != "v\$VERSION" \]; then\n[^\n]*\n\s+exit 1\n\s+fi/)
    expect(rel.jobs.verify).toContain('E404')
    expect(rel.jobs.verify).toMatch(/Could not tell whether[^\n]*\n\s+exit 1/)
    expect(rel.jobs.verify).not.toMatch(/continue-on-error|merge-base[^\n]*\|\| true/)
  })
})

describe('prepare-release.yml', () => {
  it('is dispatch only, runs on main only, never tags or publishes, has no secrets', () => {
    expect(prep.onKeys).toEqual(['workflow_dispatch'])
    expect(prep.text).not.toMatch(/workflow_run|pull_request|branches-ignore/)
    expect(prep.jobs.prepare).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
    expect(prep.text).not.toMatch(/^\s*git tag|npm stage|secrets|NPM_TOKEN|NODE_AUTH_TOKEN|id-token/m)
    expect(prep.text).toMatch(/npm version "\$BUMP" --no-git-tag-version/)
    expect(prep.text).toMatch(/npm version "\$BUMP" --preid "\$PREID" --no-git-tag-version/)
    expect(prep.text).toMatch(/npm ci --ignore-scripts/)
    expect(prep.emptyTopPerms).toBe(true)
    expect(norm(block(prep.jobs.prepare, 'permissions', 4))).toBe('contents: write|pull-requests: write|actions: write')
  })
})

describe('touched workflows', () => {
  it('pin every third-party action to a full SHA with a version comment', () => {
    for (const f of touched) {
      const uses = read(f).split('\n').filter((x) => /^\s*-?\s*uses:/.test(x))
      expect(uses.length, f).toBeGreaterThan(0)
      for (const l of uses) expect(l, f).toMatch(/@[0-9a-f]{40} # v\d/)
    }
  })

  it('never use pull_request_target or workflow_run', () => {
    for (const f of fs.readdirSync(WF).filter((x) => /\.ya?ml$/.test(x))) {
      expect(stripComments(read(f)), f).not.toMatch(/pull_request_target|workflow_run/)
    }
  })

  it('only release.yml references secrets or the npm token', () => {
    for (const f of touched.filter((x) => x !== 'release.yml')) {
      expect(stripComments(read(f)), f).not.toMatch(/secrets|NPM_TOKEN|NODE_AUTH_TOKEN/)
    }
  })
})
