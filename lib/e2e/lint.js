'use strict';
const { loadFlow, collectFlowFiles } = require('./flow');

// Static flow lint. Warnings only: selector matching is never changed, and warnings never fail the run.

const GROUP_REASON = 'subtype "Group" never matches: sgnodes dumps a Group node as "RenderableNode" '
  + '(seen on firmware 16.0.4). Select by id or text instead (docs: e2e/flows, "Group shows up as RenderableNode").';

// Every selector-shaped map a normalized step carries (step.selector; pressUntil/waitFor nest it).
function selectorsOf(step) {
  return step.selector && typeof step.selector === 'object' ? [step.selector] : [];
}

// Lint a loaded flow ({ name, file, steps }). Returns [{ rule, flow, file, line, message }].
function lintFlow(flow) {
  const warnings = [];
  for (const step of flow.steps) {
    for (const sel of selectorsOf(step)) {
      if (sel.subtype === 'Group') {
        warnings.push({ rule: 'group-subtype', flow: flow.name, file: flow.file, line: step.line, message: GROUP_REASON });
      }
    }
  }
  return warnings;
}

function formatWarning(w) {
  return `warning: ${w.flow}:${w.line} ${w.message}`;
}

// CLI entry: lint files/dirs, print warnings, return exit code (0 = no parse errors; warnings are not errors).
function lint(inputs, log = console.log, cfg = null) {
  let code = 0;
  let total = 0;
  for (const file of collectFlowFiles(inputs)) {
    let flow;
    try { flow = loadFlow(file); } catch (e) { console.error(`error: ${e.message}`); code = 1; continue; }
    if (cfg) { // net config: instrument.net merged with the flow's config.net
      const netSteps = require('./net-steps');
      if (netSteps.usesNet(flow)) {
        const m = netSteps.preflight([file], cfg, loadFlow)[0];
        if (m) { console.error(`error: ${flow.name}: ${m.message}`); code = 1; continue; }
      }
    }
    for (const w of lintFlow(flow)) { log(formatWarning(w)); total++; }
  }
  log(`brighttest e2e lint: ${total} warning(s)`);
  return code;
}

module.exports = { lintFlow, formatWarning, lint, GROUP_REASON };
