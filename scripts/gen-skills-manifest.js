'use strict';
// Regenerate skills/manifest.json from the skills/ tree. Run after adding/removing a skill or its files:
//   npm run skills:manifest
// Also writes skills/facts.json (brighttest-facts/v1): the numbers and names the skills may claim, read from the code.
// The manifest (brighttest-skills/v2: skills, agents, alwaysOn, facts) lists each skill and its files so `brighttest skills update` can fetch them remotely.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'skills');

const { generateManifest } = require('../lib/skills');

// Throws (non-zero exit) when an agent names an unknown skill or host, or the always-on block is over its line cap.
const manifest = generateManifest(root);
const skills = manifest.skills;
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote skills/manifest.json (${skills.length} skills)`);

// Facts come after the manifest (the skill list is read from it). Deterministic: sorted keys, trailing newline.
const { collectFacts, renderFacts } = require('../lib/skills');
fs.writeFileSync(path.join(root, 'facts.json'), renderFacts(collectFacts(path.join(__dirname, '..'))));
console.log('wrote skills/facts.json');
