#!/usr/bin/env node
'use strict';
// Runs axe-core (accessibility checks) on every page of the built docs site, in the light and the dark theme.
//
//   npm run docs:build && npm run docs:a11y
//
// Needs Chrome ($CHROME_BIN or a standard install) and the two packages axe-core and puppeteer-core. They are not
// dependencies of this repo. Install them anywhere and point at that folder:
//   mkdir /some/dir && cd /some/dir && npm init -y && npm i axe-core puppeteer-core
//   DOCS_A11Y_DEPS=/some/dir npm run docs:a11y
// With no Chrome or no packages it prints a note and exits 0 (skipped). Flags: --json <file> saves the raw findings.
//
// Two rules are left out because they come from the default VitePress theme and not from our files:
//   nested-interactive (sidebar groups), label-content-name-mismatch (search button).
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createRequire } = require('module');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'docs', '.vitepress', 'dist');
const BASE = '/brighttest/';
const UPSTREAM = ['nested-interactive', 'label-content-name-mismatch'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function skip(why) { console.log(`docs:a11y skipped: ${why}`); process.exit(0); }

function findChrome() {
  return [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    .filter(Boolean).find((p) => fs.existsSync(p));
}

function listPages(dir, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === 'assets' || e.name === 'mapping-results' ? [] : listPages(path.join(dir, e.name), r);
    return e.name.endsWith('.html') ? [r] : [];
  });
}

async function main() {
  if (!fs.existsSync(path.join(dist, 'index.html'))) skip('no built site; run npm run docs:build first');
  const chrome = findChrome();
  if (!chrome) skip('no Chrome found (set CHROME_BIN)');
  const req = createRequire(path.join(process.env.DOCS_A11Y_DEPS || root, 'x.js'));
  let puppeteer, axeSrc;
  try { puppeteer = req('puppeteer-core'); axeSrc = fs.readFileSync(req.resolve('axe-core/axe.min.js'), 'utf8'); } catch { skip('axe-core / puppeteer-core not found (set DOCS_A11Y_DEPS)'); }

  const server = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    p = p.startsWith(BASE) ? p.slice(BASE.length) : p.slice(1);
    if (!p || p.endsWith('/')) p += 'index.html';
    const f = path.join(dist, p);
    if (!f.startsWith(dist)) { r.writeHead(403); return r.end(); }
    fs.readFile(f, (e, d) => {
      if (e) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      r.end(d);
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  const findings = [];
  const pages = listPages(dist);
  try {
    for (const theme of ['light', 'dark']) {
      for (const pg of pages) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.evaluateOnNewDocument((t) => localStorage.setItem('vitepress-theme-appearance', t), theme);
        await page.goto(`http://127.0.0.1:${port}${BASE}${pg}`, { waitUntil: 'networkidle0' });
        await page.evaluate(axeSrc);
        const res = await page.evaluate((skipRules) => axe.run(document, { resultTypes: ['violations'], rules: Object.fromEntries(skipRules.map((r) => [r, { enabled: false }])) }), UPSTREAM);
        for (const v of res.violations) {
          for (const n of v.nodes) findings.push({ theme, page: pg, rule: v.id, selector: n.target.join(' '), html: n.html.slice(0, 200) });
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  const ji = process.argv.indexOf('--json');
  if (ji > 0) fs.writeFileSync(process.argv[ji + 1], JSON.stringify(findings, null, 1));
  for (const f of findings) console.log(`${f.theme} ${f.page} ${f.rule} ${f.selector}\n    ${f.html.replace(/\s+/g, ' ')}`);
  console.log(`docs:a11y: ${pages.length} pages x 2 themes, ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
