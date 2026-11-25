'use strict'
// The brighttest-feature-tree/v1 document: ids, enums, caps and exit codes in one place. `features check` validates
// against these, and `scripts/gen-skills-manifest.js` publishes them as the `featureTree` block of skills/facts.json.
//
//   facts() -> plain object (sorted by the caller): schema ids, enums, caps, exit codes, rule ids

const { CLASS_ORDER } = require('./testability')

const TREE_SCHEMA = 'brighttest-feature-tree/v1'
const CHECK_SCHEMA = 'brighttest-feature-check/v1'
const GRAPH_SCHEMA = 'brighttest-feature-graph/v1'

const KINDS = ['app-shell', 'screen', 'flow', 'service', 'widget', 'shared', 'platform', 'vendor']
const RISKS = ['low', 'medium', 'high']
// The five lanes. `unknown` is a prediction gap, never a lane, so it is not here.
const LANES = CLASS_ORDER.slice()
const NEEDS = ['net', 'state', 'store', 'media', 'registry']
const PATHS = ['leaf-first', 'base-first']
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const CAPS = { name: 60, summary: 400, why: 300, reason: 300, notes: 300, features: 400, proposedTestsPerFeature: 20 }
const EXIT = { ok: 0, internal: 1, usage: 2, invalid: 3 }
const RULES = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9']

// Keys each object may carry; anything else is a V1 error (so a model cannot author `dependsOn`, which is computed).
const KEYS = {
  tree: ['schema', 'graph', 'provenance', 'features', 'ignored', 'paths'],
  graph: ['hash', 'treeHash'],
  provenance: ['author', 'createdFrom'],
  feature: ['id', 'name', 'kind', 'summary', 'members', 'risk', 'testability', 'proposedTests', 'notes'],
  testability: ['overrides'],
  override: ['node', 'class', 'reason', 'evidence'],
  proposedTest: ['target', 'lane', 'needs', 'title', 'why'],
  ignored: ['members', 'reason'],
  paths: ['recommended', 'reason'],
}

function facts() {
  return {
    schema: TREE_SCHEMA,
    checkSchema: CHECK_SCHEMA,
    graphSchema: GRAPH_SCHEMA,
    kinds: KINDS.slice(),
    risks: RISKS.slice(),
    lanes: LANES.slice(),
    needs: NEEDS.slice(),
    paths: PATHS.slice(),
    idPattern: SLUG_RE.source,
    caps: { ...CAPS },
    exitCodes: { ...EXIT },
    rules: RULES.slice(),
  }
}

module.exports = { TREE_SCHEMA, CHECK_SCHEMA, GRAPH_SCHEMA, KINDS, RISKS, LANES, NEEDS, PATHS, SLUG_RE, CAPS, EXIT, RULES, KEYS, facts }
