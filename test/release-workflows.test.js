import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Structural checks on the release workflows. No YAML dependency: the files use a regular layout (2-space keys),
// so the text is parsed by indentation after dropping comments. `actionlint` covers real syntax.
//
// Mutations this suite is proven against (each applied to the workflow, confirmed to fail a test, then reverted):
//  1 add a pull_request trigger            2 id-token on verify                  3 contents: write on publish
//  4 a secret used in verify               5 dry_run refusal loses its exit 1    6 npm publish replaces npm stage publish
//  7 `npm --tag x publish`                 8 ancestor check neutered             9 prepare-release loses its main-only if
// 10 workflow_run trigger                 11 branches-ignore on the tag trigger 12 publish runs on dispatch
// 13 unpinned action in test.yml          14 toJSON(secrets)                    15 integrity comparison deleted
// 16 empty expected integrity accepted    17 `exit 1` removed from "already on npm" 18 gh release edit --draft=false
// 19 non-draft gh release create          20 checkout (or ref:) added to publish 21 root npm ci in publish
// 22 cache: on publish                    23 persist-credentials removed from a checkout 24 notes_ready check removed
// 25 branch-exists check removed          26 preid validation removed           27 permissions: write-all anywhere
// 28 test.yml top-level permissions removed/widened 29 pull-requests: write outside prepare-release
// 30 repo script run in publish           31 token passed to a step other than stage
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
    expect(stage).toMatch(/npm stage publish "\$PKG_DIR\/\$TARBALL" --ignore-scripts --access public --tag "\$DIST_TAG" --provenance/)
    expect(stage).not.toMatch(/continue-on-error|npm (ci|install|run)\b/)
  })

  it('publish runs no repository code and stages the verified tarball', () => {
    const pub = rel.jobs.publish
    expect(pub).not.toMatch(/actions\/checkout/)
    expect(pub).not.toMatch(/^\s+ref:/m)
    expect(pub).not.toMatch(/npm (ci|install)\b(?! -g npm@11\.21\.3)/)
    expect(pub).not.toMatch(/^\s+(cache|package-manager-cache): (?!false)/m)
    expect(pub).not.toMatch(/scripts\/|node_modules|npm run|npx /)
    expect(pub).toMatch(/actions\/download-artifact@[0-9a-f]{40}/)
    const stage = stepOf(pub, 'Stage the package (not live until approved)')
    expect(stage).toMatch(/npm stage publish "\$PKG_DIR\/\$TARBALL" --ignore-scripts --access public --tag "\$DIST_TAG" --provenance/)
    expect(stage).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  })

  it('compares the tarball integrity with verify and fails on empty or different values', () => {
    const meta = stepOf(rel.jobs.publish, 'Verify the tarball integrity and work out version and dist-tag')
    expect(meta).not.toBeNull()
    expect(meta).toMatch(/EXPECTED: \$\{\{ needs\.verify\.outputs\.integrity \}\}/)
    expect(meta).toMatch(/if \[ -z "\$EXPECTED" \]; then\n[^\n]*\n\s+exit 1\n\s+fi/)
    expect(meta).toMatch(/if \[ "\$ACTUAL" != "\$EXPECTED" \]; then\n[^\n]*\n\s+exit 1\n\s+fi/)
    expect(meta).toMatch(/createHash\("sha512"\)/)
    expect(meta).toMatch(/\*-\*\) TAG=next ;;\n\s+\*\) TAG=latest ;;/)
    expect(meta).not.toMatch(/secrets|NODE_AUTH_TOKEN|continue-on-error|\|\| true/)
    expect(rel.jobs.publish.indexOf('Verify the tarball integrity')).toBeLessThan(rel.jobs.publish.indexOf('Stage the package'))
    // verify builds a real tarball, reports its integrity and uploads it
    expect(rel.jobs.verify).toMatch(/npm pack --ignore-scripts --json --pack-destination/)
    expect(rel.jobs.verify).toMatch(/integrity: \$\{\{ steps\.pack\.outputs\.integrity \}\}/)
    expect(rel.jobs.verify).toMatch(/release-check\.js pack "\$RUNNER_TEMP\/pack\.json"/)
    expect(rel.jobs.verify).toMatch(/actions\/upload-artifact@[0-9a-f]{40}[\s\S]*retention-days: 1/)
  })

  it('every checkout in the release workflows disables credential persistence', () => {
    for (const t of [rel.text, prep.text]) {
      const steps = t.split(/\n {6}- /).filter((x) => x.startsWith('uses: actions/checkout'))
      expect(steps.length).toBeGreaterThan(0)
      for (const st of steps) expect(st).toMatch(/persist-credentials: false/)
    }
  })

  it('never runs a plain npm publish (any spelling)', () => {
    for (const t of [rel.text, prep.text]) expect(t).not.toMatch(/\bnpm\b(?!\s+stage)[^\n]*\bpublish\b/)
    expect(rel.text).toMatch(/a===11&&b>=15/) // npm >= 11.15 gate
  })

  it('creates the GitHub Release as a draft on a verified tag', () => {
    const j = rel.jobs['github-release']
    expect(j).toMatch(/gh release create .*--draft/)
    expect(j).toMatch(/--verify-tag/)
    expect(j).toMatch(/DRAFT/)
    expect(rel.text.match(/gh release create/g)).toHaveLength(1)
    expect(rel.text).not.toMatch(/gh release (edit|upload|delete)|--draft=false|--latest|gh api[^\n]*releases|--draft=/)
    expect(j).toMatch(/--draft --verify-tag/)
  })

  it('verify runs every gate, fails closed, and the ancestor check can fail the run', () => {
    for (const s of ['--version-env', 'check --tags', 'release-check.js deps', 'npm run test:unit', 'npm run test:integration', 'release-check.js pack ']) {
      expect(rel.jobs.verify).toContain(s)
    }
    expect(rel.jobs.verify).toMatch(/if ! git merge-base --is-ancestor "\$SHA" origin\/main; then\n[^\n]*\n\s+exit 1\n\s+fi/)
    expect(rel.jobs.verify).toMatch(/if \[ "\$REF_NAME" != "v\$VERSION" \]; then\n[^\n]*\n\s+exit 1\n\s+fi/)
    expect(rel.jobs.verify).toMatch(/already on npm\. Versions cannot be reused[^\n]*\n\s+exit 1\n\s+fi/)
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
    expect(prep.text).not.toMatch(/^\s*(git tag|npm stage)|secrets|NPM_TOKEN|NODE_AUTH_TOKEN|id-token/m)
    expect(prep.text).toMatch(/npm version "\$BUMP" --no-git-tag-version/)
    expect(prep.text).toMatch(/npm version "\$BUMP" --preid "\$PREID" --no-git-tag-version/)
    expect(prep.text).toMatch(/npm ci --ignore-scripts/)
    expect(prep.emptyTopPerms).toBe(true)
    const nr = stepOf(prep.jobs.prepare, 'Require confirmation')
    expect(nr).toContain('if [ "$NOTES_READY" != "true" ]; then')
    expect(nr).toMatch(/\n\s+exit 1\n\s+fi/)
    expect(prep.jobs.prepare).toMatch(/if git ls-remote --exit-code --heads origin "\$BRANCH"[^\n]*; then\n[^\n]*\n\s+exit 1\n\s+fi/)
    expect(prep.jobs.prepare).toMatch(/if ! printf '%s' "\$PREID" \| grep -Eq '[^']+'; then echo "[^"]*"; exit 1; fi/)
    expect(prep.jobs.prepare).not.toMatch(/\|\| true/)
    expect(norm(block(prep.jobs.prepare, 'permissions', 4))).toBe('contents: write|pull-requests: write|actions: write')
  })
})

describe('touched workflows', () => {
  it('test.yml is read-only at the top level and no job widens it', () => {
    const t = stripComments(read('test.yml'))
    expect(norm(block(t, 'permissions'))).toBe('contents: read')
    expect(t.match(/^ {4}permissions:/gm)).toBeNull()
  })

  it('no workflow uses write-all or other permission widening; pull-requests: write only in prepare-release', () => {
    for (const f of fs.readdirSync(WF).filter((x) => /\.ya?ml$/.test(x))) {
      const t = stripComments(read(f))
      expect(t, f).not.toMatch(/write-all/)
      if (f !== 'prepare-release.yml') expect(t, f).not.toMatch(/pull-requests: write/)
    }
  })

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
