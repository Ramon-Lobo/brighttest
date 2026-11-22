'use strict'
// Test-only bsc plugin: appends a statement that emits invalid BrightScript to source/net.brs, simulating a
// rewrite that produces broken output (TP-INS-22 step 4). List it after the instrument plugin.
const { Statement, Range } = require('brighterscript')
class Broken extends Statement {
  constructor() { super(); this.range = Range.create(0, 0, 0, 0) }
  transpile() { return ['x = = 1'] }
  walk() {}
  clone() { return new Broken() }
}
module.exports = () => ({
  name: 'break-rewrite',
  beforeFileTranspile(e) {
    if (e.file.pkgPath.replace(/\\/g, '/') === 'source/net.brs') e.editor.addToArray(e.file.ast.statements, e.file.ast.statements.length, new Broken())
  },
})
