'use strict'
// Test-only bsc plugin: after the instrument plugin, replaces the `statements` of every `init` body with a copy that
// starts with `print "late-edit"` (an own-property edit through the AstEditor, as a user plugin could do).
const { Statement, Range } = require('brighterscript')
class Late extends Statement {
  constructor() { super(); this.range = Range.create(0, 0, 0, 0) }
  transpile() { return ['print "late-edit"'] }
  walk() {}
  clone() { return new Late() }
}
module.exports = () => ({
  name: 'late-body-edit',
  beforeFileTranspile(e) {
    if (!e.file.parser || !e.file.parser.references) return
    for (const fn of e.file.parser.references.functionStatements) {
      if (String(fn.name.text).toLowerCase() !== 'init') continue
      const body = fn.func.body
      e.editor.setProperty(body, 'statements', [new Late(), ...body.statements])
    }
  },
})
