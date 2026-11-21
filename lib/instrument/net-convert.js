'use strict';
const fs = require('fs');
const path = require('path');
const rules = require('./net-rules');

// `brighttest net convert <file.har> [-o rules.json]` (NET-N-T7; design network-interception.md 143).
// Pure core: convertHar(har) -> { rules, notes }. One rule per HAR entry, in recorded order, ids `har-1..n`.
// Per-entry conversion reuses rules.rulesFromHar, so redaction handling is identical to loading a HAR as a fixture:
// redacted query values become `*`, redacted header values are blanked, and redacted body text stays as the
// recorder wrote it (the placeholder), never a real secret. Repeated method+url entries get `times: 1` (all but
// the last) so replay serves them in recorded order instead of the first rule shadowing the rest.
// `notes` lists entries whose body still carries a redaction placeholder, so the author knows to hand-edit them.

const PLACEHOLDER = /<redacted:[^>]*>/;

function isJsonType(ct) { return /(^|[/+])json\b/i.test(String(ct || '')); }

function convertHar(har) {
  const errs = rules.validateHar(har);
  if (errs.length) throw new rules.NetRuleError(`not a valid HAR 1.2 file: ${errs[0]}`);
  const entries = har.log.entries;
  const out = [];
  const notes = [];
  entries.forEach((e, i) => {
    const rule = rules.rulesFromHar({ log: { ...har.log, entries: [e] } })[0];
    rule.id = `har-${i + 1}`;
    const ct = (e.response.content && e.response.content.mimeType) || rule.headers && rule.headers['content-type'];
    if (typeof rule.body === 'string' && isJsonType(ct)) {
      try { rule.json = JSON.parse(rule.body); delete rule.body; } catch (err) { /* keep as text */ }
    }
    if (PLACEHOLDER.test(JSON.stringify([rule.body, rule.json]))) notes.push({ id: rule.id, method: rule.method, note: 'body contains a redacted value; edit before replay' });
    out.push(rule);
  });
  const lastIndex = new Map();
  out.forEach((r, i) => lastIndex.set(`${r.method} ${r.url}`, i));
  out.forEach((r, i) => { if (lastIndex.get(`${r.method} ${r.url}`) !== i) r.times = 1; });
  return { rules: out, notes };
}

function convertFile(file) {
  let har;
  try { har = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new rules.NetRuleError(`cannot read HAR file ${file}: ${e.message}`); }
  return convertHar(har);
}

// CLI body. Returns an exit code.
function run(args, { log = (m) => process.stdout.write(`${m}\n`), err = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const input = args.file;
  if (!input) { err('[brighttest] net convert needs a HAR file: brighttest net convert <file.har> [-o <rules.json>]'); return 2; }
  let res;
  try { res = convertFile(path.resolve(input)); } catch (e) { err(`[brighttest] net convert: ${e.message}`); return 1; }
  const text = JSON.stringify({ rules: res.rules }, null, 2) + '\n';
  if (args.out) {
    try { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(path.resolve(args.out), text); } catch (e) { err(`[brighttest] net convert: cannot write ${args.out}: ${e.message}`); return 1; }
    log(`[brighttest] net convert: wrote ${res.rules.length} rule(s) to ${args.out}`);
  } else process.stdout.write(text);
  for (const n of res.notes) err(`[brighttest] net convert: ${n.id} (${n.method}): ${n.note}`);
  return 0;
}

module.exports = { convertHar, convertFile, run };
