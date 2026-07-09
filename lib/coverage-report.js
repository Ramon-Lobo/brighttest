'use strict';
const { palette } = require('./reporter');

// Rooibos emits LINE coverage only (LCOV DA:/LF:/LH: records — no BRDA branch or FN function data), so
// the table reports line/statement coverage per file plus an overall total, Jest-style. Branch & function
// columns are intentionally omitted rather than faked.

// Parse a clean lcov.info string into [{ file, total, covered, uncovered:[lineNo,…] }].
function parseLcov(text) {
  const files = [];
  let cur = null;
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) { cur = { file: line.slice(3), total: 0, covered: 0, uncovered: [] }; continue; }
    if (!cur) continue;
    if (line.startsWith('DA:')) {
      const m = /^DA:(\d+),(\d+)$/.exec(line);
      if (m) { cur.total++; if (+m[2] > 0) cur.covered++; else cur.uncovered.push(+m[1]); }
      continue;
    }
    if (line === 'end_of_record') { files.push(cur); cur = null; }
  }
  return files;
}

// [2,3,4,8,11,12] → "2-4, 8, 11-12"
function compressRanges(nums) {
  if (!nums.length) return '';
  const s = [...nums].sort((a, b) => a - b);
  const out = [];
  let start = s[0], prev = s[0];
  for (let i = 1; i < s.length; i++) {
    if (s[i] === prev + 1) { prev = s[i]; continue; }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = s[i];
  }
  out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(', ');
}

function pct(covered, total) { return total === 0 ? 100 : (covered / total) * 100; }

// Jest-style thresholds: ≥80 green, ≥50 yellow, else red.
function tint(c, value, s) {
  if (value >= 80) return c.green(s);
  if (value >= 50) return c.yellow(s);
  return c.red(s);
}

function truncLeft(str, width) {
  if (str.length <= width) return str;
  return '…' + str.slice(str.length - width + 1);
}

// Print the coverage table and return the overall line-coverage percentage (or null if no data).
function printCoverageTable(lcovText, cfg, color, opts = {}) {
  const c = palette(color);
  const files = parseLcov(lcovText).sort((a, b) => a.file.localeCompare(b.file));
  if (!files.length) return null;

  const totalAll = files.reduce((n, f) => n + f.total, 0);
  const coveredAll = files.reduce((n, f) => n + f.covered, 0);
  const overall = pct(coveredAll, totalAll);

  // Column widths.
  const uncappedFileW = Math.max('All files'.length, ...files.map((f) => f.file.length));
  const fileW = Math.min(uncappedFileW, 56);
  const PCT_W = 7;    // "100.00"
  const HIT_W = Math.max('Lines'.length, ...files.map((f) => `${f.covered}/${f.total}`.length), `${coveredAll}/${totalAll}`.length);
  const UNC_CAP = opts.uncoveredWidth || 44;

  const pad = (s, w) => String(s).padEnd(w);
  const padL = (s, w) => String(s).padStart(w);
  const sep = () => c.grey(
    '-'.repeat(fileW + 2) + '|' + '-'.repeat(PCT_W + 2) + '|' + '-'.repeat(HIT_W + 2) + '|' + '-'.repeat(UNC_CAP + 1),
  );

  const row = (file, value, hit, uncovered, isHeader) => {
    const fileCell = pad(truncLeft(file, fileW), fileW);
    if (isHeader) {
      return `${c.bold(fileCell)} | ${c.bold(padL(value, PCT_W))} | ${c.bold(padL(hit, HIT_W))} | ${c.bold(uncovered)}`;
    }
    const pctCell = value == null ? pad('', PCT_W) : padL(value.toFixed(2), PCT_W);
    const hitCell = padL(hit, HIT_W);
    const cells = `${fileCell} | ${pctCell} | ${hitCell}`;
    return (value == null ? cells : tint(c, value, cells)) + ` | ${c.grey(uncovered)}`;
  };

  process.stdout.write('\n' + c.bold('  Coverage — lines/statements') + '  ' +
    c.grey('(branch & function coverage not emitted by Rooibos)') + '\n');
  process.stdout.write('  ' + row('File', '% Lines', 'Lines', 'Uncovered Line #s', true) + '\n');
  process.stdout.write('  ' + sep() + '\n');
  process.stdout.write('  ' + row('All files', overall, `${coveredAll}/${totalAll}`, '') + '\n');
  process.stdout.write('  ' + sep() + '\n');
  for (const f of files) {
    const value = pct(f.covered, f.total);
    const unc = compressRanges(f.uncovered);
    const uncCell = unc.length > UNC_CAP ? unc.slice(0, UNC_CAP - 1) + '…' : unc;
    process.stdout.write('  ' + row(f.file, value, `${f.covered}/${f.total}`, uncCell) + '\n');
  }
  process.stdout.write('  ' + sep() + '\n');
  return overall;
}

module.exports = { parseLcov, compressRanges, printCoverageTable };
