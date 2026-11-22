import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { TOOLS } = require('../lib/mcp/tools')
const __dirname = path.dirname(new URL(import.meta.url).pathname)

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'skills', 'using-brighttest-mcp', 'SKILL.md'), 'utf8');
const rows = SKILL.split('\n').filter((l) => /^\| `[a-z_]+` \|/.test(l));

// Backticked identifiers in a table cell.
const ticks = (cell) => (cell.match(/`([^`]+)`/g) || []).map((s) => s.slice(1, -1));

describe('using-brighttest-mcp skill matches the MCP server (TP-MCP-15)', () => {
  test('frontmatter names the skill', () => {
    expect(SKILL).toMatch(/^---\nname: using-brighttest-mcp\ndescription: .+\n(?:[a-z-]+: .+\n)*license: MIT\nmetadata:\n  source: brighttest\n---/);
  });

  test('tool table lists exactly the server tools', () => {
    expect(rows.map((r) => ticks(r.split('|')[1])[0]).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  test.each(TOOLS.map((t) => [t.name, t]))('%s parameters match its inputSchema', (name, tool) => {
    const row = rows.find((r) => ticks(r.split('|')[1])[0] === name);
    const cell = row.split('|')[2];
    const props = Object.keys(tool.inputSchema.properties || {});
    const required = tool.inputSchema.required || [];
    if (props.length === 0) { expect(cell.trim()).toBe('none'); return; }
    const named = ticks(cell).filter((t) => /^[a-zA-Z]+$/.test(t));
    expect(named.sort()).toEqual(props.sort());
    for (const p of props) {
      const at = cell.indexOf('`' + p + '`')
      const part = cell.slice(at, cell.indexOf(')', at) + 1);
      expect(/required/.test(part)).toBe(required.includes(p));
      const m = tool.inputSchema.properties[p];
      if (m.maximum !== undefined) expect(part).toContain(`${m.minimum}-${m.maximum}`);
    }
  });

  test('selector keys match the schema', () => {
    const sel = TOOLS.find((t) => t.name === 'inspect_tree').inputSchema.properties.selector.properties;
    const line = SKILL.split('\n').find((l) => l.startsWith('Keys: `id`'));
    const text = SKILL.slice(SKILL.indexOf(line), SKILL.indexOf('No other keys'));
    expect(ticks(text).sort()).toEqual(Object.keys(sel).sort());
  });

  test('every error code named exists in the server', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp', 'server.js'), 'utf8') +
      fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp', 'tools.js'), 'utf8');
    const sect = SKILL.slice(SKILL.indexOf('## Typed errors'), SKILL.indexOf('## Suggested loop'));
    const codes = ticks(sect).filter((c) => /^[A-Z_]+$/.test(c));
    expect(codes.length).toBeGreaterThan(10);
    for (const c of codes) expect(src).toContain(`'${c}'`);
  });

  test('is registered in the manifest', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', 'manifest.json'), 'utf8'));
    expect(m.skills.find((s) => s.name === 'using-brighttest-mcp').files).toEqual(['SKILL.md']);
  });
});
