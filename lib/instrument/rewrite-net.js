'use strict'
// brighttest instrument: net call-site rewrite (NET-N-T2; ADR 0017, ADR 0019 Amendment A). Extracted from plugin.js.
//
//   x.setUrl(e)  ->  x.setUrl(BT_url(e))           (one argument, any receiver expression, any case, ["setUrl"] excluded)
//   x.getUrl()   ->  BT_unurl(x.getUrl())          (no arguments, only where the result is used)
//
// The receiver classification (confirmed / likely / unknown / excluded) is computed by receiver.js; this module only
// applies it. It runs from the plugin's beforeFileTranspile on the AstEditor, so the source AST is restored after emit and
// nothing here changes a line number: the new call reuses the original call's range and adds no newline.
// File-level exclusions (vendor, rooibos, source/bt/**, user globs) are decided by the caller (plugin.js) before this runs.
// Idempotence: a node this module created is remembered in `done` (the walk descends into what it created), and the
// plugin refuses a second transpile of one build (BT9004), so nothing is ever wrapped twice.
const bsc = require('brighterscript')
const receiver = require('./receiver')

const {
  isDottedGetExpression, isIndexedGetExpression, isLiteralString, isExpressionStatement, isCallExpression,
  isVariableExpression, createVisitor, WalkMode,
} = bsc

const lc = (s) => String(s || '').toLowerCase()

// Member name of a call target: `a.name` or `a["name"]` (string literal), lower-cased; '' for anything else.
function calleeMember(callee) {
  if (isDottedGetExpression(callee)) return lc(callee.name.text)
  if (isIndexedGetExpression(callee) && callee.index && isLiteralString(callee.index)) {
    return lc(String(callee.index.token.text).replace(/^"|"$/g, ''))
  }
  return ''
}

// True when `n` is already `<name>(...)` with a bare identifier callee (case-insensitive).
const isCallTo = (n, name) => !!n && isCallExpression(n) && isVariableExpression(n.callee) && lc(n.callee.name.text) === name

// Apply the rewrite to one file.
//   ctx.file, ctx.editor   the bsc BrsFile and the transpile AstEditor
//   ctx.sites              receiver.analyzeFile(file) result (classified call sites)
//   ctx.call(name,args,range)  builds `name(args)` (plugin.js)
//   ctx.skip(kind,file,line,reason)  records a skipped[] entry
//   ctx.stats, ctx.netRewritten, ctx.netOverlaps, ctx.rewrittenKinds   the plugin's result accumulators
function rewriteFile(ctx) {
  const { file, editor, call, skip, stats, netRewritten, netOverlaps, rewrittenKinds } = ctx
  const done = ctx.done || new WeakSet()
  const at = (expr) => expr.range.start.line + 1
  const sites = new Map(ctx.sites.map((x) => [x.expr, x]))
  const netStat = (cls) => { stats.netRewrites[cls]++ }
  const handle = (site, kind) => {
    if (site.overlap) netOverlaps.push({ file: file.pkgPath, line: site.line, receiver: site.receiver, ...site.overlap })
    if (site.action === 'excluded') {
      skip('net-receiver-excluded', file.pkgPath, site.line, `${site.receiver}.${kind}: ${site.reason}; not rewritten`)
      netStat('excluded'); return false
    }
    if (site.action === 'unknown-skip') {
      skip('net-receiver-unknown', file.pkgPath, site.line, `${site.receiver}.${kind}: ${site.reason}; skipped because instrument.net.unknown is "report"`)
      netStat('unknown'); return false
    }
    netStat(site.cls)
    netRewritten.push({ kind, file: file.pkgPath, line: site.line, receiver: site.receiver, confidence: site.cls })
    return true
  }
  file.ast.walk(createVisitor({
    CallExpression: (expr, parent, owner, key) => {
      if (done.has(expr)) return
      const nm = calleeMember(expr.callee)
      if (!nm) return
      if (isIndexedGetExpression(expr.callee)) {
        if (nm === 'seturl' || nm === 'geturl') skip('indexed-' + nm, file.pkgPath, at(expr), `indexed call ["${nm === 'seturl' ? 'setUrl' : 'getUrl'}"] is not rewritten`)
        return
      }
      // A node another plugin created after planning has no classification: treat it as unknown (fail toward interception).
      const site = sites.get(expr) || { action: 'rewrite', cls: 'unknown', line: at(expr), receiver: receiver.toText(expr.callee.obj) || '<expression>', reason: '' }
      if (nm === 'callfunc') {
        const a0 = expr.args[0]
        if (a0 && isLiteralString(a0) && lc(String(a0.token.text).replace(/^"|"$/g, '')) === 'seturl') {
          skip('callfunc-seturl', file.pkgPath, at(expr), 'callFunc("setUrl", ...) is not rewritten and cannot work on a real roUrlTransfer (informational)')
        }
        return
      }
      if (nm === 'seturl' && expr.args.length === 1) {
        if (isCallTo(expr.args[0], 'bt_url')) return // already wrapped (source that was rewritten before)
        if (!handle(site, 'setUrl')) return
        editor.setProperty(expr.args, 0, call('BT_url', [expr.args[0]], expr.range))
        stats.setUrl++; rewrittenKinds.add(lc(file.pkgPath) + '|net')
      } else if (nm === 'geturl' && expr.args.length === 0) {
        if (!owner || isExpressionStatement(owner)) {
          skip('bare-geturl', file.pkgPath, at(expr), 'getUrl() used as a bare statement: its result is discarded, nothing to rewrite')
          return
        }
        if (isCallTo(parent, 'bt_unurl') && parent.args.length === 1 && parent.args[0] === expr) return // already wrapped
        if (!handle(site, 'getUrl')) return
        done.add(expr) // the walk descends into the node created here; never wrap twice
        editor.setProperty(owner, key, call('BT_unurl', [expr], expr.range))
        stats.getUrl++; rewrittenKinds.add(lc(file.pkgPath) + '|net')
      }
    },
  }), { walkMode: WalkMode.visitAllRecursive })
}

module.exports = { rewriteFile, calleeMember }
