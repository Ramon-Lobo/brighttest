'use strict'
// Test-only bsc plugin: forces every .brs file through AST transpile without changing it. Used as the
// line-count baseline for the instrument plugin (bsc re-emits an edited file from the AST).
module.exports = () => ({
  name: 'force-transpile',
  beforeFileTranspile(e) {
    if (e.file.pkgPath.endsWith('.brs')) e.editor.setProperty(e.file, 'needsTranspiled', true)
  },
})
