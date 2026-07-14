'use strict';
const fs = require('fs');
const { createDevice } = require('./ecp');
const sg = require('./sgnodes');

// `brighttest e2e record` — scaffold a flow by driving the device from the terminal. Roku's ECP does not
// stream the physical remote's presses to us, so recording is an interactive session: you press keys on
// the keyboard, we send the matching ECP keypress live, watch the SceneGraph settle, and transcribe each
// action into a *.e2e.yaml you then refine. Assertions and text are added on demand with command keys.
//
// The Recorder itself is pure (accumulate steps → serialize YAML) and unit-tested; runRecord() wires it to
// a raw-mode TTY.

// Pick the most stable selector for a node: prefer the built-in id, then visible text, then subtype.
function bestSelector(node) {
  if (!node) return null;
  if (node.id) return { id: node.id };
  if (node.text) return { text: node.text };
  return { subtype: node.subtype };
}

// Serialize a scalar for the flow YAML subset: bare when safe, else double-quoted.
function serializeScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  const safeBare = s !== '' && /^[A-Za-z0-9_.\/-]+$/.test(s) &&
    !['true', 'false', 'null', '~'].includes(s) && !/^-?\d+(\.\d+)?$/.test(s);
  return safeBare ? s : JSON.stringify(s);
}

// Serialize a selector/args object as an inline flow map: `{ id: foo, count: 2 }`.
function serializeInlineMap(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${serializeScalar(v)}`);
  return `{ ${parts.join(', ')} }`;
}

// One normalized step → a `- …` YAML line.
function serializeStep(step) {
  switch (step.op) {
    case 'launch':
      return step.params && Object.keys(step.params).length
        ? `  - launch: ${serializeInlineMap(step.params)}`
        : '  - launch';
    case 'press':
      return step.count > 1
        ? `  - press: ${serializeInlineMap({ key: step.key, count: step.count })}`
        : `  - press: ${serializeScalar(step.key)}`;
    case 'text': return `  - text: ${serializeScalar(step.value)}`;
    case 'focus': return `  - focus: ${serializeInlineMap(step.selector)}`;
    case 'assertVisible': return `  - assertVisible: ${serializeInlineMap(step.selector)}`;
    case 'assertGone': return `  - assertGone: ${serializeInlineMap(step.selector)}`;
    case 'assertFocused': return `  - assertFocused: ${serializeInlineMap(step.selector)}`;
    case 'assertText':
      return `  - assertText: ${serializeInlineMap({ ...step.selector, equals: step.equals, contains: step.contains })}`;
    case 'screenshot': return `  - screenshot: ${serializeScalar(step.name)}`;
    case 'back': return '  - back';
    case 'home': return '  - home';
    default: throw new Error(`cannot serialize step op: ${step.op}`);
  }
}

class Recorder {
  constructor({ appId = 'dev' } = {}) {
    this.appId = appId;
    this.steps = [{ op: 'launch' }];
  }
  // Record a keypress, coalescing an immediately-repeated identical key into a count.
  press(key) {
    const last = this.steps[this.steps.length - 1];
    if (last && last.op === 'press' && last.key === key) last.count = (last.count || 1) + 1;
    else this.steps.push({ op: 'press', key, count: 1 });
    return this;
  }
  back() { this.steps.push({ op: 'back' }); return this; }
  home() { this.steps.push({ op: 'home' }); return this; }
  text(value) { this.steps.push({ op: 'text', value }); return this; }
  screenshot(name) { this.steps.push({ op: 'screenshot', name }); return this; }
  assertFocused(node) {
    const sel = bestSelector(node);
    if (sel) this.steps.push({ op: 'assertFocused', selector: sel });
    return this;
  }
  assertVisible(node) {
    const sel = bestSelector(node);
    if (sel) this.steps.push({ op: 'assertVisible', selector: sel });
    return this;
  }
  assertText(node) {
    const sel = bestSelector(node);
    if (sel && node && node.text != null) this.steps.push({ op: 'assertText', selector: sel, equals: node.text });
    return this;
  }
  // Serialize the recording to flow YAML.
  toYAML() {
    const lines = [
      '# Recorded by `brighttest e2e record` — review and refine before committing.',
      `appId: ${serializeScalar(this.appId)}`,
      'steps:',
      ...this.steps.map(serializeStep),
    ];
    return lines.join('\n') + '\n';
  }
}

// ---- interactive session -----------------------------------------------------------------------

const KEYMAP = {
  '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
  '\r': 'Select', '\n': 'Select', '\x7f': 'Back',
};
const HELP = `
  arrows  move · enter select · backspace Back · h Home
  a assertFocused · v assertVisible · x assertText · t type text · p screenshot
  ? help · q save & quit · Ctrl-C abort
`;

// The deepest focused node with an id/text, for on-screen feedback + assertions.
async function currentFocus(device) {
  try {
    const tree = await sg.fetchTree(device);
    const focused = sg.flatten(tree.roots).filter((n) => n.focused);
    return focused.length ? focused[focused.length - 1] : null;
  } catch (e) { return null; }
}

// Read a single line in cooked mode (for `t`/`p` prompts), then restore raw mode.
function readLine(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const wasRaw = process.stdin.isRaw;
    if (wasRaw) process.stdin.setRawMode(false);
    let buf = '';
    const onData = (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        process.stdin.removeListener('data', onData);
        if (wasRaw) process.stdin.setRawMode(true);
        resolve(buf.slice(0, nl).replace(/\r$/, ''));
      }
    };
    process.stdin.on('data', onData);
  });
}

// Run the interactive recorder. Returns the YAML string (and writes it to opts.out if given).
async function runRecord(device, opts, io = process) {
  const rec = new Recorder({ appId: opts.app || 'dev' });
  await device.launch(rec.appId);
  await sg.waitForSettle(device).catch(() => {});
  io.stdout.write(`recording ${rec.appId} — press ? for help, q to save & quit\n`);

  const feedback = async (label) => {
    const f = await currentFocus(device);
    io.stdout.write(`  ${label}${f ? `  (focus: ${f.subtype}#${f.id || '?'}${f.text ? ` "${f.text}"` : ''})` : ''}\n`);
  };

  if (!io.stdin.isTTY) throw new Error('e2e record needs an interactive terminal (TTY).');
  io.stdin.setRawMode(true);
  io.stdin.resume();

  return await new Promise((resolve, reject) => {
    const finish = () => {
      io.stdin.setRawMode(false); io.stdin.pause();
      const yaml = rec.toYAML();
      if (opts.out) { fs.writeFileSync(opts.out, yaml); io.stdout.write(`\nsaved ${rec.steps.length} steps → ${opts.out}\n`); }
      else io.stdout.write('\n' + yaml);
      resolve(yaml);
    };
    const onData = async (data) => {
      const s = data.toString();
      if (s === '\x03') { io.stdin.setRawMode(false); io.stdin.pause(); return reject(new Error('recording aborted')); }
      if (s === 'q') { io.stdin.removeListener('data', onData); return finish(); }
      if (s === '?') { io.stdout.write(HELP); return; }
      if (KEYMAP[s]) {
        const key = KEYMAP[s];
        try { await device.keypress(key); } catch (e) { io.stdout.write(`  ! ${e.message}\n`); return; }
        if (key === 'Back') rec.back(); else rec.press(key);
        await sg.waitForSettle(device).catch(() => {});
        await feedback(key === 'Back' ? 'Back' : key);
        return;
      }
      if (s === 'h') { await device.keypress('Home').catch(() => {}); rec.home(); await feedback('Home'); return; }
      if (s === 'a' || s === 'v' || s === 'x') {
        const f = await currentFocus(device);
        if (!f) { io.stdout.write('  ! nothing focused to assert\n'); return; }
        if (s === 'a') rec.assertFocused(f);
        else if (s === 'v') rec.assertVisible(f);
        else rec.assertText(f);
        io.stdout.write(`  + ${s === 'a' ? 'assertFocused' : s === 'v' ? 'assertVisible' : 'assertText'} ${f.id ? '#' + f.id : f.subtype}\n`);
        return;
      }
      if (s === 't') {
        const txt = await readLine('  text to type: ');
        if (txt) { await device.text(txt).catch((e) => io.stdout.write(`  ! ${e.message}\n`)); rec.text(txt); await feedback(`typed ${JSON.stringify(txt)}`); }
        return;
      }
      if (s === 'p') {
        const name = (await readLine('  screenshot name (blank = auto): ')) || `shot-${rec.steps.length}.png`;
        rec.screenshot(name);
        io.stdout.write(`  + screenshot ${name}\n`);
        return;
      }
    };
    io.stdin.on('data', onData);
  });
}

module.exports = { Recorder, runRecord, bestSelector, serializeStep, serializeScalar, serializeInlineMap };
