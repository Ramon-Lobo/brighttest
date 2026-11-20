#!/usr/bin/env node
// Zero-dependency generator: emits a synthetic many-file variant of the legacy app into a scratch dir
// (for census timing). Nothing is committed; the output dir is yours.
//
//   node tools/scale.js --copies N --out <dir>        N total copies of components/ (default 12)
//   node tools/scale.js --census [--dir <app-dir>]    print the census counts as JSON
//
// Copy 0 is the app as-is (source/, certs/, manifest, components/). Copies 1..N-1 are components only:
// every component name gets a `_cK` suffix and `pkg:/components/` paths a `cK/` segment, so the
// generated tree stays a valid, collision-free SceneGraph project.
'use strict'
const fs = require('fs')
const path = require('path')

const APP = path.resolve(__dirname, '..')

function walk(dir, filter, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, out)
    else if (!filter || filter(p)) out.push(p)
  }
  return out
}

// Ground truth counted over source/ (minus tests) and components/ of an app dir.
function census(appDir) {
  const files = ['source', 'components']
    .filter((d) => fs.existsSync(path.join(appDir, d)))
    .flatMap((d) => walk(path.join(appDir, d), (p) => !p.includes(`${path.sep}tests${path.sep}`)))
  const c = {
    brsFiles: 0, xmlFiles: 0, components: 0, tasks: 0,
    urlTransferLiteral: 0, createObjectDynamic: 0, syncGet: 0, asyncGet: 0, certificateCalls: 0,
  }
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8')
    if (f.endsWith('.brs')) {
      c.brsFiles++
      c.urlTransferLiteral += (t.match(/CreateObject\(\s*"roUrlTransfer"\s*\)/gi) || []).length
      c.createObjectDynamic += (t.match(/CreateObject\(\s*[A-Za-z_]\w*\s*\)/gi) || []).length
      c.syncGet += (t.match(/\.getToString\(/gi) || []).length
      c.asyncGet += (t.match(/\.asyncGetToString\(/gi) || []).length
      c.certificateCalls += (t.match(/\.setCertificatesFile\(/gi) || []).length
    } else if (f.endsWith('.xml')) {
      c.xmlFiles++
      if (/<component\s/.test(t)) c.components++
      if (/<component[^>]*extends="Task"/.test(t)) c.tasks++
    }
  }
  return c
}

function copyTree(src, dest, transform) {
  for (const f of walk(src)) {
    const rel = path.relative(src, f)
    const out = path.join(dest, rel)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    if (transform && /\.(xml|brs)$/.test(f)) fs.writeFileSync(out, transform(fs.readFileSync(f, 'utf8')))
    else fs.copyFileSync(f, out)
  }
}

function scale(copies, outDir) {
  if (!Number.isInteger(copies) || copies < 1) throw new Error('--copies must be a positive integer')
  fs.mkdirSync(outDir, { recursive: true })
  fs.copyFileSync(path.join(APP, 'manifest'), path.join(outDir, 'manifest'))
  copyTree(path.join(APP, 'certs'), path.join(outDir, 'certs'))
  copyTree(path.join(APP, 'source'), path.join(outDir, 'source'), null)
  fs.rmSync(path.join(outDir, 'source', 'tests'), { recursive: true, force: true })
  copyTree(path.join(APP, 'components'), path.join(outDir, 'components'), null)
  const names = walk(path.join(APP, 'components'), (p) => p.endsWith('.xml'))
    .map((f) => (fs.readFileSync(f, 'utf8').match(/<component\s+name="(\w+)"/) || [])[1])
    .filter(Boolean)
  const re = new RegExp(`\\b(${names.join('|')})\\b(?!\\.(?:brs|xml))`, 'g')
  for (let k = 1; k < copies; k++) {
    copyTree(path.join(APP, 'components'), path.join(outDir, 'components', `c${k}`), (t) =>
      t.replace(re, `$1_c${k}`).replace(/pkg:\/components\//g, `pkg:/components/c${k}/`))
  }
  return census(outDir)
}

function main(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  if (argv.includes('--census')) {
    console.log(JSON.stringify(census(get('--dir') ? path.resolve(get('--dir')) : APP), null, 2))
    return
  }
  const out = get('--out')
  if (!out) { console.error('usage: scale.js --copies N --out <dir> | --census [--dir <dir>]'); process.exit(2) }
  const copies = get('--copies') === undefined ? 12 : Number(get('--copies'))
  const result = scale(copies, path.resolve(out))
  const total = walk(path.resolve(out)).length
  console.log(JSON.stringify({ out: path.resolve(out), copies, totalFiles: total, census: result }, null, 2))
}

if (require.main === module) main(process.argv.slice(2))
module.exports = { census, scale }
