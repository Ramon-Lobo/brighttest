'use strict'
// Zero-dependency zip reader for untrusted packages (ADR 0053 decisions 1 to 3). It parses the end-of-central-directory
// record and the central directory, refuses unsafe archives BEFORE inflating anything, and inflates single entries
// into memory with a hard output cap. Nothing is ever written to disk from an entry name.
//
// readCentralDirectory(buf, caps?) -> { entries: [{ name, method, csize, usize, offset, flags, dir }] }
// inflateEntry(buf, entry, maxBytes) -> Buffer
// Errors are ZipError with code BUILD_INVALID_ZIP (not a readable zip) or BUILD_UNSAFE_ZIP (refused); `.reason` is the
// short human reason ("encrypted entries are not supported"), also the message.
const zlib = require('node:zlib')

const MB = 1024 * 1024
const DEFAULT_CAPS = Object.freeze({
  maxEntries: 20000,
  maxUncompressed: 512 * MB, // declared total
  ratioMinBytes: 1 * MB,     // ratio check applies to entries over this size
  maxRatio: 100,
  maxNameBytes: 1024,
})

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

class ZipError extends Error {
  constructor(code, reason) {
    super(reason)
    this.name = 'ZipError'
    this.code = code
    this.reason = reason
  }
}
const invalid = (r) => new ZipError('BUILD_INVALID_ZIP', r)
const unsafe = (r) => new ZipError('BUILD_UNSAFE_ZIP', r)

// Why a name is unsafe, or null. Directory entries (trailing slash) are checked without the slash.
function badName(name, nameBytes, maxNameBytes) {
  if (!name) return 'empty entry name'
  if (nameBytes > maxNameBytes) return `entry name over ${maxNameBytes} bytes`
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'entry name with a NUL or control character'
  if (name.includes('\\')) return 'entry name with a backslash'
  if (name.startsWith('/')) return 'absolute entry name'
  if (/^[A-Za-z]:/.test(name)) return 'entry name with a drive letter'
  if (name.split('/').includes('..')) return 'entry name with a ".." segment'
  return null
}

function findEocd(buf) {
  const min = 22
  if (buf.length < min) throw invalid('too short to be a zip')
  const lowest = Math.max(0, buf.length - min - 0xffff)
  for (let i = buf.length - min; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const clen = buf.readUInt16LE(i + 20)
      if (i + min + clen === buf.length) return i
    }
  }
  throw invalid('no end of central directory')
}

function readCentralDirectory(buf, caps) {
  if (!Buffer.isBuffer(buf)) throw invalid('input is not a buffer')
  const c = Object.assign({}, DEFAULT_CAPS, caps || {})
  const eocd = findEocd(buf)
  // zip64: locator right before the EOCD, or any saturated EOCD field
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) throw unsafe('zip64 archives are not supported')
  const disk = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const countDisk = buf.readUInt16LE(eocd + 8)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw unsafe('zip64 archives are not supported')
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw invalid('multi-disk archives are not supported')
  if (count > c.maxEntries) throw unsafe(`more than ${c.maxEntries} entries`)
  if (cdOffset + cdSize > eocd) throw invalid('central directory out of range')

  const entries = []
  const seen = new Set()
  let total = 0
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) throw invalid('bad central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const end = p + 46 + nlen + elen + clen
    if (end > eocd) throw invalid('bad central directory')
    const nameBuf = buf.subarray(p + 46, p + 46 + nlen)
    const name = nameBuf.toString('utf8')
    // zip64 markers: saturated sizes or offset, or a zip64 extra field (id 0x0001)
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw unsafe('zip64 archives are not supported')
    for (let e = p + 46 + nlen, eEnd = e + elen; e + 4 <= eEnd; e += 4 + buf.readUInt16LE(e + 2)) {
      if (buf.readUInt16LE(e) === 0x0001) throw unsafe('zip64 archives are not supported')
    }
    if (flags & 0x1 || flags & 0x40) throw unsafe('encrypted entries are not supported')
    if (method !== 0 && method !== 8) throw unsafe(`unsupported compression method ${method} (only stored and deflate)`)
    const bad = badName(name, nlen, c.maxNameBytes)
    if (bad) throw unsafe(bad)
    if (seen.has(name)) throw unsafe('duplicate entry names')
    seen.add(name)
    if (usize > c.ratioMinBytes && usize > c.maxRatio * csize) throw unsafe(`compression ratio over ${c.maxRatio}:1 (possible zip bomb)`)
    total += usize
    if (total > c.maxUncompressed) throw unsafe(`declared size over ${Math.round(c.maxUncompressed / MB)} MB uncompressed`)
    entries.push({ name, method, csize, usize, offset, flags, dir: name.endsWith('/'), _nameBuf: nameBuf })
    p = end
  }

  // central and local headers must agree (done after the cheap checks so bombs are refused first)
  for (const e of entries) {
    const o = e.offset
    if (o + 30 > cdOffset || buf.readUInt32LE(o) !== SIG_LOCAL) throw invalid('bad local header')
    const lflags = buf.readUInt16LE(o + 6)
    const lmethod = buf.readUInt16LE(o + 8)
    const lcsize = buf.readUInt32LE(o + 18)
    const lusize = buf.readUInt32LE(o + 22)
    const lnlen = buf.readUInt16LE(o + 26)
    const lelen = buf.readUInt16LE(o + 28)
    if (lflags & 0x1 || lflags & 0x40) throw unsafe('encrypted entries are not supported')
    const lname = buf.subarray(o + 30, o + 30 + lnlen)
    if (lmethod !== e.method || lnlen !== e._nameBuf.length || !lname.equals(e._nameBuf)) throw unsafe('central and local headers disagree')
    if (!(lflags & 0x8) && (lcsize !== e.csize || lusize !== e.usize)) throw unsafe('central and local headers disagree')
    e._data = o + 30 + lnlen + lelen
    if (e._data + e.csize > cdOffset) throw invalid('entry data out of range')
    delete e._nameBuf
  }
  return { entries }
}

// Inflates one entry into memory. The output is capped at the DECLARED size (a lying header fails instead of
// expanding) and the declared size must not exceed maxBytes. The result length must equal the declared size.
function inflateEntry(buf, entry, maxBytes) {
  if (entry.usize > maxBytes) throw unsafe(`entry ${entry.name} is over ${maxBytes} bytes`)
  if (entry.usize === 0) return Buffer.alloc(0)
  const data = buf.subarray(entry._data, entry._data + entry.csize)
  let out
  if (entry.method === 0) {
    if (entry.csize !== entry.usize) throw unsafe('declared size does not match the data')
    out = Buffer.from(data)
  } else {
    try { out = zlib.inflateRawSync(data, { maxOutputLength: entry.usize }) } catch (e) {
      throw unsafe(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'declared size does not match the data' : 'corrupt compressed data')
    }
  }
  if (out.length !== entry.usize) throw unsafe('declared size does not match the data')
  return out
}

module.exports = { readCentralDirectory, inflateEntry, ZipError, DEFAULT_CAPS }
