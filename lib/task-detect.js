'use strict';
const fs = require('fs');
const path = require('path');

// Component XML files under rootDir that declare a Task node (`<component ... extends="Task">`).
// Returned paths are rootDir-relative with forward slashes. The headless `-n` lane runs with SceneGraph off, so
// the engine cannot run Task nodes there (COV-04).
function findTaskComponents(rootDir) {
  const out = [];
  const skip = new Set(['node_modules', '.brighttest', '.git', 'out']);
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); }
      else if (e.name.endsWith('.xml')) {
        try {
          const src = fs.readFileSync(p, 'utf8');
          if (/<component\b[^>]*\bextends\s*=\s*["']Task["']/i.test(src)) {
            out.push(path.relative(rootDir, p).split(path.sep).join('/'));
          }
        } catch (e2) { /* unreadable: ignore */ }
      }
    }
  })(rootDir);
  return out.sort();
}

// One warning line per Task component; warn only (the run continues, exit code unchanged).
function warnTaskUsage(rootDir, log = console.error) {
  const files = findTaskComponents(rootDir);
  for (const f of files) {
    log(`[brighttest] warning: ${f} declares a Task node; the headless lane (-n) cannot run Task on the engine. Run it on a device (--device) instead.`);
  }
  return files;
}

module.exports = { findTaskComponents, warnTaskUsage };
