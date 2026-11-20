'use strict'
// brighttest instrument: net receiver classifier (INS-F-T8; ADR 0019 Amendment A, ADR 0017 amendment).
//
// The member name (`setUrl` with one argument, `getUrl` with none, any case) is the gate and stays in the plugin's walk.
// This module classifies each gated site's RECEIVER from static evidence inside one function / one file:
//   confirmed  assigned from CreateObject("roUrlTransfer") in the same function (locals) or anywhere in the same file
//              (`m.` / `m.top.` chains), following one copy hop; or the receiver is that CreateObject call itself
//   likely     declared `as roUrlTransfer`, a name hint (xfer, transfer, urltransfer, http, req, request), or an allow match
//   unknown    call-result receiver, untyped parameter, foreign field, unresolved or second hop
//   excluded   positive evidence of another type (other CreateObject class, AA/array/literal, `new`, `m`, `m.top`,
//              `m.global`, another declared type, conflicting assignments) or a deny match; allow overrides excluded
// Deny wins over allow. No cross-function dataflow, no cross-file `m` tracking, no return-value hops. `getUrl` is
// classified from the same receiver text in the same function, so it always follows the receiver's `setUrl`.
//
// One AST walk per file (`analyzeFile`). Per-function assignments are collected during the walk and the call sites
// are classified after it. Node-class names were re-read on brighterscript 0.73.8; `missingApis()` feature-detects them.
const bsc = require('brighterscript')

const {
  isDottedGetExpression, isIndexedGetExpression, isLiteralString, isExpressionStatement, isVariableExpression,
  isCallExpression, isGroupingExpression, isLiteralExpression, isAALiteralExpression, isArrayLiteralExpression,
  isNewExpression, isFunctionExpression, createVisitor, WalkMode, TokenKind,
} = bsc

const lc = (s) => String(s || '').toLowerCase()
const NAME_HINT = /(xfer|transfer|urltransfer|^http$|^req(uest)?$)/i
const NEUTRAL_TYPES = new Set(['', 'object', 'dynamic'])
const MODES = ['rewrite', 'report']

// Names of the bsc node classes and helpers this module relies on that are missing (feature detection, ADR 0019 decision 3).
function missingApis() {
  const out = []
  for (const n of ['AssignmentStatement', 'DottedSetStatement', 'NewExpression', 'FunctionExpression', 'LiteralExpression',
    'AALiteralExpression', 'ArrayLiteralExpression', 'VariableExpression', 'GroupingExpression', 'CallExpression']) {
    if (typeof bsc[n] !== 'function') out.push(`${n} (net receiver classifier)`)
  }
  for (const n of ['isNewExpression', 'isAALiteralExpression', 'isArrayLiteralExpression', 'isGroupingExpression', 'isFunctionExpression', 'isLiteralExpression']) {
    if (typeof bsc[n] !== 'function') out.push(`${n} (net receiver classifier)`)
  }
  if (typeof bsc.CallExpression === 'function' && typeof bsc.CallExpression.prototype.findAncestor !== 'function') out.push('Expression#findAncestor (net receiver classifier)')
  return out
}

// ---- glob (receiver text and file path) -------------------------------------------------------------------------
// File globs: `*` stays inside a path segment, `**` crosses them. Receiver globs: `*` matches anything, `?` one char.
function globToRegExp(glob) {
  let re = ''
  const g = String(glob).replace(/\\/g, '/')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$', 'i')
}
function receiverGlob(glob) {
  let re = ''
  for (const c of String(glob)) re += c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + re + '$', 'i')
}

// Pattern: `<receiver glob>` or `<file glob>#<receiver glob>`. The receiver text is matched lower-cased.
function compilePatterns(list) {
  return (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string' && p.trim()).map((src) => {
    const i = src.indexOf('#')
    return { src, file: i >= 0 ? globToRegExp(src.slice(0, i)) : null, recv: receiverGlob(lc(i >= 0 ? src.slice(i + 1) : src)) }
  })
}
const matchPattern = (pats, file, text) => pats.find((p) => (!p.file || p.file.test(String(file).replace(/\\/g, '/').replace(/^\/+/, ''))) && p.recv.test(lc(text)))

// ---- receiver text -----------------------------------------------------------------------------------------------
function unwrap(n) { while (n && isGroupingExpression(n)) n = n.expression; return n }
function toText(n) {
  n = unwrap(n)
  if (!n) return null
  if (isVariableExpression(n)) return n.name.text
  if (isDottedGetExpression(n)) { const o = toText(n.obj); return o === null ? null : o + '.' + n.name.text }
  if (isCallExpression(n)) { const c = toText(n.callee); return c === null ? null : c + '()' }
  return null
}
const isCreateObject = (n) => isCallExpression(n) && isVariableExpression(n.callee) && lc(n.callee.name.text) === 'createobject'
const isMChain = (lt) => lt.startsWith('m.')

// Class of the value on the right of an assignment.
function valueClass(v, fn, hops, ctx) {
  v = unwrap(v)
  if (isCreateObject(v)) {
    const a = v.args[0]
    if (a && isLiteralExpression(a) && isLiteralString(a)) {
      const type = String(a.token.text).replace(/^"|"$/g, '')
      return lc(type) === 'rourltransfer' ? { cls: 'confirmed' } : { cls: 'excluded', reason: `assigned from CreateObject("${type}")` }
    }
    return { cls: 'unknown', reason: 'CreateObject with a non-literal type name' }
  }
  if (isCallExpression(v)) return { cls: 'unknown', reason: 'assigned from a call result (return-value hops are not followed)' }
  if (isAALiteralExpression(v)) return { cls: 'excluded', reason: 'assigned an associative array literal' }
  if (isArrayLiteralExpression(v)) return { cls: 'excluded', reason: 'assigned an array literal' }
  if (isNewExpression(v)) return { cls: 'excluded', reason: 'assigned from `new` (a user class instance)' }
  if (isLiteralExpression(v)) {
    if (v.token && v.token.kind === TokenKind.Invalid) return { cls: 'unknown', reason: 'assigned invalid' }
    return { cls: 'excluded', reason: 'assigned a non-transfer literal' }
  }
  const text = toText(v)
  if (text !== null && !/\(\)/.test(text)) {
    if (hops <= 0) return { cls: 'unknown', reason: 'copy chain longer than one hop' }
    const r = refClass(text, fn, hops - 1, ctx)
    return r.cls === 'none' ? { cls: 'unknown', reason: `copied from ${text}, which has no assignment in scope` } : r
  }
  return { cls: 'unknown', reason: 'assignment right side is not resolvable statically' }
}

function combine(list) {
  const has = (c) => list.some((x) => x.cls === c)
  if (has('confirmed') && has('excluded')) return { cls: 'excluded', reason: 'conflicting assignments (a transfer and another type)' }
  if (has('unknown')) return list.find((x) => x.cls === 'unknown')
  if (has('excluded')) return list.find((x) => x.cls === 'excluded')
  return { cls: 'confirmed' }
}

// Assignment evidence for a name (same function) or an `m.` chain (same file). `none` when nothing is assigned.
function refClass(text, fn, hops, ctx) {
  const lt = lc(text)
  let sources = []
  if (isMChain(lt)) sources = ctx.mAssigns.get(lt) || []
  else if (!lt.includes('.')) sources = ((ctx.assigns.get(fn) || new Map()).get(lt) || []).map((value) => ({ value, fn }))
  if (!sources.length) return { cls: 'none' }
  return combine(sources.map((s) => valueClass(s.value, s.fn, hops, ctx)))
}

// Class of the receiver of one gated call (before allow/deny).
function evidenceFor(recv, fn, ctx) {
  const node = unwrap(recv)
  if (isCreateObject(node)) return valueClass(node, fn, 0, ctx)
  if (isCallExpression(node)) return { cls: 'unknown', reason: 'receiver is a call result' }
  if (isAALiteralExpression(node) || isArrayLiteralExpression(node) || isNewExpression(node) || isLiteralExpression(node)) return valueClass(node, fn, 0, ctx)
  const text = toText(node)
  if (text === null) return { cls: 'unknown', reason: 'receiver expression is not resolvable statically' }
  const lt = lc(text)
  if (lt === 'm' || lt === 'm.top' || lt === 'm.global') return { cls: 'excluded', reason: `receiver ${text} is a component/global object, not a transfer` }
  const ev = refClass(text, fn, 1, ctx)
  if (ev.cls !== 'none') return ev
  const simple = !lt.includes('.')
  if (simple && fn) {
    const p = (fn.parameters || []).find((q) => lc(q.name && q.name.text) === lt)
    const type = p && p.typeToken && p.typeToken.text ? lc(p.typeToken.text) : ''
    if (p && type === 'rourltransfer') return { cls: 'likely', reason: 'parameter declared as roUrlTransfer' }
    if (p && !NEUTRAL_TYPES.has(type)) return { cls: 'excluded', reason: `parameter declared as ${p.typeToken.text}` }
  }
  const terminal = text.split('.').pop()
  if (NAME_HINT.test(terminal)) return { cls: 'likely', reason: `name hint "${terminal}"` }
  if (simple) return { cls: 'unknown', reason: 'no assignment or type evidence in this function (untyped parameter or outer value)' }
  return { cls: 'unknown', reason: lt.startsWith('m.') ? 'm field with no assignment in this file' : 'field of another object' }
}

// ---- classifier ----------------------------------------------------------------------------------------------------
// cfg: { allow:[], deny:[], unknown:'rewrite'|'report' }. Returns { analyzeFile(file), errors }.
function createClassifier(cfg) {
  cfg = cfg || {}
  const errors = []
  const mode = cfg.unknown === undefined ? 'rewrite' : cfg.unknown
  if (!MODES.includes(mode)) errors.push(`instrument.net.unknown must be "rewrite" or "report", got ${JSON.stringify(cfg.unknown)}`)
  const unknownMode = mode === 'report' ? 'report' : 'rewrite'
  const allow = compilePatterns(cfg.allow)
  const deny = compilePatterns(cfg.deny)

  // Every `<x>.setUrl(` / `<x>.getUrl(` call (any arity, dotted or indexed) in one walk. `eligible` is true when the
  // plugin will consider rewriting it (non-indexed setUrl with one arg; getUrl() whose result is used).
  function analyzeFile(file) {
    const ctx = { assigns: new Map(), mAssigns: new Map() }
    const calls = []
    const fnOf = (n) => n.findAncestor(isFunctionExpression)
    file.ast.walk(createVisitor({
      AssignmentStatement: (s) => {
        const fn = fnOf(s)
        if (!ctx.assigns.has(fn)) ctx.assigns.set(fn, new Map())
        const m = ctx.assigns.get(fn); const k = lc(s.name.text)
        if (!m.has(k)) m.set(k, [])
        m.get(k).push(s.value)
      },
      DottedSetStatement: (s) => {
        const o = toText(s.obj)
        if (o === null || !(lc(o) === 'm' || lc(o).startsWith('m.'))) return
        const k = lc(o + '.' + s.name.text)
        if (!ctx.mAssigns.has(k)) ctx.mAssigns.set(k, [])
        ctx.mAssigns.get(k).push({ value: s.value, fn: fnOf(s) })
      },
      CallExpression: (expr, parent, owner) => {
        const callee = expr.callee
        let name = ''
        if (isDottedGetExpression(callee)) name = lc(callee.name.text)
        else if (isIndexedGetExpression(callee) && callee.index && isLiteralString(callee.index)) name = lc(String(callee.index.token.text).replace(/^"|"$/g, ''))
        if (name !== 'seturl' && name !== 'geturl') return
        calls.push({ expr, owner, name, indexed: isIndexedGetExpression(callee) })
      },
    }), { walkMode: WalkMode.visitAllRecursive })

    const pkg = file.pkgPath
    return calls.map(({ expr, owner, name, indexed }) => {
      const eligible = !indexed && ((name === 'seturl' && expr.args.length === 1) ||
        (name === 'geturl' && expr.args.length === 0 && !!owner && !isExpressionStatement(owner)))
      const site = { expr, name, indexed, eligible, line: expr.range.start.line + 1, receiver: '', cls: null, reason: '', action: null, overlap: null }
      if (!eligible) return site
      const recv = expr.callee.obj
      site.receiver = isCreateObject(unwrap(recv)) ? 'CreateObject(...)' : (toText(recv) || '<expression>')
      const ev = evidenceFor(recv, fnOf(expr), ctx)
      const d = matchPattern(deny, pkg, site.receiver)
      const a = matchPattern(allow, pkg, site.receiver)
      if (d && a) site.overlap = { allow: a.src, deny: d.src }
      if (d) { site.cls = 'excluded'; site.reason = `matches instrument.net.receivers.deny "${d.src}"` }
      else if (a) {
        site.cls = ev.cls === 'confirmed' ? 'confirmed' : 'likely'
        site.reason = ev.cls === 'confirmed' ? '' : `matches instrument.net.receivers.allow "${a.src}"` + (ev.cls === 'excluded' ? ` (overrides: ${ev.reason})` : '')
      } else { site.cls = ev.cls; site.reason = ev.reason || '' }
      site.action = site.cls === 'excluded' ? 'excluded' : (site.cls === 'unknown' && unknownMode === 'report') ? 'unknown-skip' : 'rewrite'
      return site
    })
  }
  return { analyzeFile, errors, unknownMode, allow: allow.map((p) => p.src), deny: deny.map((p) => p.src) }
}

module.exports = { createClassifier, missingApis, compilePatterns, matchPattern, globToRegExp, toText, NAME_HINT }
