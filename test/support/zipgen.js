'use strict'
// Generates zips in memory for the builds tests, including malformed ones (header overrides). Synthetic content only.
const zlib = require('node:zlib')

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

// entries: [{ name, data, method: 8|0|n, flags, extra, central: {csize,usize,method,flags,extra}, local: {...}, rawData }]
// opts: { comment, zip64Locator, eocdCount, eocdCdOffset, truncateAt }
function makeZip(entries, opts = {}) {
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data == null ? '' : e.data)
    const method = e.method == null ? 8 : e.method
    const comp = e.rawData || (method === 8 ? zlib.deflateRawSync(data) : data)
    const name = Buffer.from(e.name, 'utf8')
    const flags = e.flags || 0
    const extra = e.extra || Buffer.alloc(0)
    const L = Object.assign({ csize: comp.length, usize: data.length, method, flags, extra }, e.local || {})
    const C = Object.assign({ csize: comp.length, usize: data.length, method, flags, extra }, e.central || {})
    const lname = e.localName ? Buffer.from(e.localName) : name
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(L.flags), u16(L.method), u16(0), u16(0x21), u32(0), u32(L.csize),
      u32(L.usize), u16(lname.length), u16(L.extra.length), lname, L.extra, comp])
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(C.flags), u16(C.method), u16(0), u16(0x21), u32(0), u32(C.csize),
      u32(C.usize), u16(name.length), u16(C.extra.length), u16(0), u16(0), u16(0), u32(0), u32(offset), name, C.extra]))
    parts.push(local)
    offset += local.length
  }
  const cd = Buffer.concat(central)
  const comment = Buffer.from(opts.comment || '')
  const tail = []
  if (opts.zip64Locator) tail.push(Buffer.concat([u32(0x07064b50), u32(0), u32(0), u32(0), u32(1)]).subarray(0, 20))
  tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(opts.eocdCount == null ? entries.length : opts.eocdCount),
    u32(cd.length), u32(opts.eocdCdOffset == null ? offset : opts.eocdCdOffset), u16(comment.length), comment]))
  const buf = Buffer.concat([...parts, cd, ...tail])
  return opts.truncateAt != null ? buf.subarray(0, opts.truncateAt) : buf
}

const MANIFEST = 'title=Sample App\nmajor_version=1\nminor_version=4\nbuild_version=118\n'
const plainEntries = (extra = []) => [
  { name: 'manifest', data: MANIFEST },
  { name: 'source/main.brs', data: 'sub main()\nend sub\n' },
  ...extra,
]
const instrumentedEntries = () => [
  { name: 'manifest', data: MANIFEST + 'bt_instrumented=1\nbs_const=BT_AGENT=true\n' },
  { name: 'source/main.brs', data: 'sub main()\n  print "__bt_agent"\nend sub\n' },
  { name: 'source/bt/BT_config.brs', data: 'function BT_config() as object\n  return { token: "0123456789abcdef0123456789abcdef" }\nend function\n' },
  { name: 'components/Scene.xml', data: '<component name="Scene"><script uri="BT_Agent.brs"/></component>' },
]

module.exports = { makeZip, MANIFEST, plainEntries, instrumentedEntries, u16, u32 }
