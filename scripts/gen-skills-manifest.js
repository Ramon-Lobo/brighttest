'use strict';
// Regenerate skills/manifest.json from the skills/ tree. Run after adding/removing a skill or its files:
//   npm run skills:manifest
// The manifest lists each skill and its files so `brighttest skills update` can fetch them remotely.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'skills');

function walk(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

const skills = fs.readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'SKILL.md')))
  .map((d) => ({ name: d.name, files: walk(path.join(root, d.name), '').sort() }))
  .sort((a, b) => a.name.localeCompare(b.name));

const manifest = { schema: 'brighttest-skills/v1', skills };
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote skills/manifest.json (${skills.length} skills)`);
