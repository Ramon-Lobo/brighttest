'use strict'
// Transpile-time wrap of one named function (STA-S-T10): the original is renamed to __bt_orig_<name> (same line, same
// body) and a wrapper with the original name is appended to the file. `dispatch` emits state.action around the call,
// `task` publishes the Task's filtered m at entry and exit. A defaulted parameter keeps its name and its default
// expression text in the wrapper signature, so the original's own default applies when the caller omits the argument.
// A dispatch target used as a value (`{ dispatch: dispatchAction }`) is refused at plan time (valueUse): the wrapper is a
// plain function, so it would lose the AA method binding of m. All AST internals for this feature live here.
const bsc = require('brighterscript')

const { ParseMode, Parser, TokenKind, WalkMode, isDottedSetStatement, isVariableExpression, isCallExpression } = bsc
const ORIG = '__bt_orig_'

// `sub`, or `function ... as void` (no value to return).
const isSub = (fn) => (!!fn.func.functionType && fn.func.functionType.kind === TokenKind.Sub) ||
  (!!fn.func.returnTypeToken && fn.func.returnTypeToken.kind === TokenKind.Void)

// Source text of an expression, sliced from the file contents by its range.
function sourceOf(text, range) {
  const lines = text.split(/\r?\n/)
  const a = range.start, b = range.end
  if (a.line === b.line) return lines[a.line].slice(a.character, b.character)
  return [lines[a.line].slice(a.character), ...lines.slice(a.line + 1, b.line), lines[b.line].slice(0, b.character)].join(' ')
}

// First place where `name` is referenced other than as the callee of a call, in the files `accept` passes, else null.
function valueUse(program, name, accept) {
  const want = name.toLowerCase()
  let hit = null
  for (const f of Object.values(program.files)) {
    if (hit || !accept(f)) continue
    f.ast.walk((node, parent) => {
      if (!hit && isVariableExpression(node) && node.name.text.toLowerCase() === want && !(isCallExpression(parent) && parent.callee === node)) {
        hit = { file: f.pkgPath, line: node.range.start.line + 1 }
      }
    }, { walkMode: WalkMode.visitAllRecursive })
  }
  return hit
}

// BrightScript text of the wrapper. `label` is the dispatch function name or the Task component name.
function wrapperSource(fn, kind, label, text) {
  const name = fn.name.text
  const ps = fn.func.parameters.map((p) => ({ id: p.name.text, def: p.defaultValue ? sourceOf(text, p.defaultValue.range) : null }))
  const sig = ps.map((p) => (p.def !== null ? `${p.id} = ${p.def}` : `${p.id} as dynamic`)).join(', ')
  const args = ps.map((p) => p.id).join(', ')
  const sub = isSub(fn)
  const g = 'type(m.global) = "roSGNode"'
  const callOrig = `${sub ? '' : '__bt_r = '}${ORIG}${name}(${args})`
  const body = kind === 'dispatch'
    ? ['    __bt_h = ""', `    __bt_on = ${g}`, '    if __bt_on then __bt_h = BT_dwHash(m.global)', `    ${callOrig}`,
      `    if __bt_on then BT_dwEmit(m.global, "${label}", ${ps.length ? ps[0].id : 'invalid'}, __bt_h)`]
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
  const parsed = Parser.parse(wrapperSource(fn, kind, label, file.fileContents), { mode: ParseMode.BrightScript })
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

module.exports = { ORIG, wrapperSource, applyWrap, taskFunctionName, valueUse }
