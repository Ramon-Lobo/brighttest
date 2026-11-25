#!/usr/bin/env node
'use strict';
// Regenerates the mapping reports published under docs/public/mapping-results/<app>/index.html, and (with --screenshots)
// the page screenshots (framed on the Feature tree section) under docs/public/images/mapping-results/<app>.png.
//
//   node scripts/docs-mapping-results.js                 write the three reports
//   node scripts/docs-mapping-results.js --check         exit 1 if a committed report differs from a fresh render
//   node scripts/docs-mapping-results.js --screenshots   also write 1280x800 screenshots (needs Chrome; $CHROME_BIN)
//
// Each report is exactly what the CLI produces from the committed files of an example app:
//   brighttest features graph examples/<app> --out <tmp>, then features render --auto (graph only, no agent).
// Nothing is edited afterwards. Read-only on the examples; no network, no device.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const APPS = ['feature-tree-app', 'greenfield-app', 'streaming-app'];
const outFile = (app) => path.join(root, 'docs', 'public', 'mapping-results', app, 'index.html');
const shotFile = (app) => path.join(root, 'docs', 'public', 'images', 'mapping-results', `${app}.png`);

function cli(args, cwd) {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'cli.js'), ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`brighttest ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
}

// Returns the report bytes for one example app.
function renderApp(app) {
  const appDir = path.join(root, 'examples', app);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mapres-'));
  try {
    cli(['features', 'graph', appDir, '--out', tmp], root);
    const report = path.join(tmp, 'report.html');
    cli(['features', 'render', '--auto', '--graph', path.join(tmp, 'graph.json'), '--out', report], appDir);
    return fs.readFileSync(report);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findChrome() {
  return [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .filter(Boolean).find((p) => fs.existsSync(p));
}

function screenshot(app) {
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome found: set CHROME_BIN');
  const dest = shotFile(app);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mapres-chrome-'));
  // Frame the shot on the Feature tree section (Summary hidden, every feature expanded; scrolling is unreliable in headless screenshots): render from a temp copy of the report
  // with its CSP meta dropped and a small script appended, so the published HTML is untouched.
  const framed = path.join(prof, 'framed.html');
  const inject = '<script>(function(){var s=document.getElementById("tree");if(!s)return;' +
    's.querySelectorAll("details").forEach(function(d){d.open=true;});' +
    'var m=document.getElementById("summary");if(m)m.style.display="none";})();</script>';
  fs.writeFileSync(framed, fs.readFileSync(outFile(app), 'utf8')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('</body>', inject + '</body>'));
  try {
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${prof}`,
      '--window-size=1280,800', '--force-device-scale-factor=1', `--screenshot=${dest}`, require('url').pathToFileURL(framed).href],
    { stdio: 'ignore', timeout: 60000, killSignal: 'SIGKILL' });
    if (r.error || !fs.existsSync(dest)) throw new Error(`screenshot of ${app} failed`);
  } finally {
    fs.rmSync(prof, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  let stale = 0;
  for (const app of APPS) {
    const bytes = renderApp(app);
    const dest = outFile(app);
    if (check) {
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(bytes)) { console.error(`stale: ${path.relative(root, dest)}`); stale++; }
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    console.log(`wrote ${path.relative(root, dest)}`);
    if (argv.includes('--screenshots')) { screenshot(app); console.log(`wrote ${path.relative(root, shotFile(app))}`); }
  }
  if (stale) process.exit(1);
}

module.exports = { APPS, outFile, renderApp };
if (require.main === module) main();
