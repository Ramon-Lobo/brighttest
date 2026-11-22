'use strict'
// Transpile-time wrap of one named function (STA-S-T10): the original is renamed to __bt_orig_<name> (same line, same
// body) and a wrapper with the original name is appended to the file. `dispatch` emits state.action around the call,
// `task` publishes the Task's filtered m at entry and exit. A parameter with a default value is passed on as `invalid`
// when the caller omits it (the wrapper cannot see the default). All AST internals for this feature live here.
const bsc = require('brighterscript')

const { ParseMode, Parser, TokenKind, isDottedSetStatement } = bsc
const ORIG = '__bt_orig_'

const isSub = (fn) => !!fn.func.functionType && fn.func.functionType.kind === TokenKind.Sub

// BrightScript text of the wrapper. `label` is the dispatch function name or the Task component name.
function wrapperSource(fn, kind, label) {
  const name = fn.name.text
  const ps = fn.func.parameters.map((p, i) => ({ id: `p${i}`, opt: !!p.defaultValue }))
  const sig = ps.map((p) => (p.opt ? `${p.id} = invalid` : `${p.id} as dynamic`)).join(', ')
  const args = ps.map((p) => p.id).join(', ')
  const sub = isSub(fn)
  const g = 'type(m.global) = "roSGNode"'
  const callOrig = `${sub ? '' : '__bt_r = '}${ORIG}${name}(${args})`
  const body = kind === 'dispatch'
    ? ['    __bt_h = ""', `    __bt_on = ${g}`, '    if __bt_on then __bt_h = BT_dwHash(m.global)', `    ${callOrig}`,
      `    if __bt_on then BT_dwEmit(m.global, "${label}", ${ps.length ? 'p0' : 'invalid'}, __bt_h)`]
    : [`    if ${g} then BT_taskSnap(m.global, "${label}", "entry", m)`, `    ${callOrig}`,
      `    if ${g} then BT_taskSnap(m.global, "${label}", "exit", m)`]
  return [
    `${sub ? 'sub' : 'function'} ${name}(${sig})${sub ? '' : ' as dynamic'}`,
    ...body,
    ...(sub ? [] : ['    return __bt_r']),
    `end ${sub ? 'sub' : 'function'}`,
    '',
  ].join('\n')
}

// Renames `fn` and appends its wrapper to `file`; returns the 1-based line of the original.
function applyWrap(file, editor, fn, kind, label) {
  const parsed = Parser.parse(wrapperSource(fn, kind, label), { mode: ParseMode.BrightScript })
  if (parsed.diagnostics.some((d) => d.severity === 1)) throw new Error(`brighttest instrument: could not build the wrapper for ${fn.name.text}`)
  editor.setProperty(fn.name, 'text', ORIG + fn.name.text)
  const stmts = file.ast.statements
  editor.arraySplice(stmts, stmts.length, 0, ...parsed.ast.statements)
  return fn.name.range.start.line + 1
}

// The string literal assigned by `m.top.functionName = "X"` among the top-level statements of `init`, else null.
function taskFunctionName(initFn) {
  for (const s of initFn.func.body.statements) {
    if (!isDottedSetStatement(s) || !s.name || s.name.text.toLowerCase() !== 'functionname') continue
    const v = s.value
    if (v && v.token && v.token.kind === TokenKind.StringLiteral) return String(v.token.text).replace(/^"|"$/g, '')
  }
  return null
}

module.exports = { ORIG, wrapperSource, applyWrap, taskFunctionName }
