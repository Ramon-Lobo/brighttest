'use strict';
// SPK-SP2 prototype of the brighttest instrument plugin (bsc 0.73). Scratch code, not for lib/.
const path = require('path');
const bsc = require('brighterscript');
const minimatch = require('minimatch');
const {
  isBrsFile, isXmlFile, isCallExpression, isDottedGetExpression, isCommentStatement,
  createVisitor, WalkMode, CallExpression, VariableExpression, Statement, createIdentifier, createToken, TokenKind,
} = bsc;
const SGTypes = require('brighterscript/dist/parser/SGTypes');
const fs = require('fs');

const OPTS = Object.assign({
  net: true, scene: true, op: true,
  sameLine: true,        // prepend bootstrap on the first statement's line (keeps line numbers)
  naiveOp: false,        // disable the inheritance guard (shows why it is needed)
  exclude: ['source/vendor/**', 'source/rooibos/**', 'roku_modules/**', 'components/bt/**', 'source/bt/**', '**/*rooibos*/**', '**/*.spec.*'],
  log: false,
}, process.env.BT_SPIKE ? JSON.parse(process.env.BT_SPIKE) : {});

const RUNTIME_PKG = 'source/bt/BT_runtime.brs';
const RUNTIME_SRC = fs.readFileSync(path.join(__dirname, 'runtime', 'BT_runtime.brs'), 'utf8');
const lc = (s) => String(s || '').toLowerCase();
const excluded = (pkgPath) => OPTS.exclude.some((g) => minimatch(pkgPath.replace(/\\/g, '/'), g, { dot: true, nocase: true }));

// Statement wrapper: emits `<prefix> : <original first statement>` on the original line.
class PrefixedStatement extends Statement {
  constructor(prefixText, inner) { super(); this.prefixText = prefixText; this.inner = inner; }
  get range() { return this.inner.range; }
  transpile(state) { return [state.sourceNode(this.inner, this.prefixText + ' : '), ...this.inner.transpile(state)]; }
  walk(visitor, options) { /* injected; deliberately opaque (delegating the walk breaks rooibos coverage edits: tried) */ }
  clone() { return new PrefixedStatement(this.prefixText, this.inner.clone()); }
}
class BareCallStatement extends Statement {
  constructor(text, anchor) { super(); this.text = text; this.anchor = anchor; }
  get range() { return this.anchor.range; }
  transpile(state) { return [state.sourceNode(this.anchor, this.text)]; }
  walk() {}
  clone() { return new BareCallStatement(this.text, this.anchor); }
}

function call(name, args, anchorRange) {
  return new CallExpression(
    new VariableExpression(createIdentifier(name, anchorRange)),
    createToken(TokenKind.LeftParen, '(', anchorRange), createToken(TokenKind.RightParen, ')', anchorRange), args);
}

module.exports = function factory() {
  const state = { sceneInits: new Map(), stats: { setUrl: 0, getUrl: 0, initPrepend: 0, initSynth: 0, opInjected: 0, opSkippedInherited: 0, runtimeImports: 0 } };
  let program;
  return {
    name: 'bt-spike-instrument',
    afterProgramCreate(p) { program = p; global.__BT_STATS = state.stats; },

    // Runs after every file is parsed and before validation, so injected script imports are seen by scopes.
    beforeProgramValidate(p) {
      program = p;
      if (!p.getFile(RUNTIME_PKG)) p.setFile({ src: path.resolve('__bt_runtime__.brs'), dest: RUNTIME_PKG }, RUNTIME_SRC);
      const comps = [];
      for (const f of Object.values(p.files)) if (isXmlFile(f) && f.componentName) comps.push(f);
      const byName = new Map(comps.map((f) => [lc(f.componentName.text), f]));
      const chain = (f) => { const out = []; let n = lc(f.parentComponentName && f.parentComponentName.text); const seen = new Set();
        while (n && !seen.has(n)) { seen.add(n); out.push(n); const pf = byName.get(n); n = pf ? lc(pf.parentComponentName && pf.parentComponentName.text) : ''; } return out; };
      const rootBuiltin = (f) => { const c = chain(f); return c.length ? c[c.length - 1] : ''; };
      const injectable = (f) => !excluded(f.pkgPath) && !/rooibos/i.test(f.pkgPath);
      const addScript = (f, pkg) => {
        const script = new SGTypes.SGScript(); script.uri = 'pkg:/' + pkg; script.type = 'text/brightscript';
        f.ast.component.scripts.push(script);
        f.parser.references.scriptTagImports.push({ pkgPath: pkg, text: 'pkg:/' + pkg, filePathRange: bsc.Range.create(0, 0, 0, 0) });
        f.attachDependencyGraph(p.dependencyGraph);
      };
      const ownScripts = (f) => f.scriptTagImports.map((i) => lc(i.pkgPath));
      const provides = (f, pkg) => ownScripts(f).includes(lc(pkg));

      // 1) runtime import + BT_op declaration with the inheritance guard
      const ordered = [...comps].sort((x, y) => chain(x).length - chain(y).length); // ancestors first
      for (const f of ordered) {
        if (!injectable(f)) continue;
        const ancestors = chain(f).map((n) => byName.get(n)).filter(Boolean);
        const inheritedRuntime = ancestors.some((a) => injectable(a) && (provides(a, RUNTIME_PKG) || a.__btRuntime));
        if (!inheritedRuntime || OPTS.naiveOp) { if (!f.__btRuntime) { addScript(f, RUNTIME_PKG); f.__btRuntime = true; state.stats.runtimeImports++; } }
        if (OPTS.op) {
          const declared = (x) => !!x.ast.component.api && x.ast.component.api.functions.some((fn) => lc(fn.name) === 'bt_op');
          const inheritedOp = ancestors.some((a) => declared(a));
          if (!declared(f) && (!inheritedOp || OPTS.naiveOp)) {
            if (!f.ast.component.api) f.ast.component.api = new SGTypes.SGInterface();
            f.ast.component.api.setFunction('BT_op'); state.stats.opInjected++;
          } else if (inheritedOp) state.stats.opSkippedInherited++;
        }
      }

      // 2) Scene init prepend/synthesis (idempotent via a runtime flag; plugin picks root-most user Scene without init)
      state.sceneInits.clear();
      if (OPTS.scene) {
        const isScene = (f) => rootBuiltin(f) === 'scene' || lc(f.parentComponentName && f.parentComponentName.text) === 'scene';
        const inlineInit = (f) => (f.ast.component.scripts || []).some((sc) => sc.cdata && /\b(sub|function)\s+init\s*\(/i.test(sc.cdata.text || ''));
        const findInit = (f) => {
          for (const imp of f.getAvailableScriptImports()) {
            const bf = p.getFile(imp);
            if (isBrsFile(bf) && !excluded(bf.pkgPath)) {
              const fn = bf.parser.references.functionStatements.find((s) => lc(s.name && s.name.text) === 'init');
              if (fn) return { bf, fn };
            }
          }
          return null;
        };
        const covered = new Map();
        const cov = (f) => {
          if (covered.has(f)) return covered.get(f);
          const own = findInit(f);
          let c = !!own;
          if (!c) { const par = byName.get(lc(f.parentComponentName && f.parentComponentName.text)); if (par && isScene(par)) c = cov(par); }
          covered.set(f, c); return c;
        };
        for (const f of comps) {
          if (!isScene(f) || !injectable(f)) continue;
          const own = findInit(f);
          if (own) { state.sceneInits.set(own.bf.pkgPath, (state.sceneInits.get(own.bf.pkgPath) || new Set()).add(own.fn)); continue; }
          const par = byName.get(lc(f.parentComponentName && f.parentComponentName.text));
          if (cov(f)) continue;
          if (inlineInit(f)) { state.stats.inlineInitUnhandled = (state.stats.inlineInitUnhandled || 0) + 1; continue; }
          if (par && isScene(par)) continue; // parent (user Scene) will be synthesized instead
          const stub = `components/bt/BT_init_${f.componentName.text}.brs`;
          if (!p.getFile(stub)) {
            p.setFile({ src: path.resolve('__bt_init__' + f.componentName.text + '.brs'), dest: stub }, `sub init()\n    BT_bootstrap(m.top)\nend sub\n`);
            addScript(f, stub); state.stats.initSynth++;
          }
        }
      }
    },

    beforeFileTranspile(event) {
      const file = event.file;
      if (!isBrsFile(file) || excluded(file.pkgPath)) return;
      const editor = event.editor;
      const done = new WeakSet();
      if (OPTS.net) {
        file.ast.walk(createVisitor({
          CallExpression: (expr, parent, owner, key) => {
            if (done.has(expr) || !isDottedGetExpression(expr.callee)) return;
            const nm = lc(expr.callee.name.text);
            if (nm === 'seturl' && expr.args.length === 1) {
              editor.setProperty(expr.args, 0, call('BT_url', [expr.args[0]], expr.range));
              state.stats.setUrl++;
            } else if (nm === 'geturl' && expr.args.length === 0 && owner) {
              done.add(expr); // the walk descends into the node we just created; do not wrap twice
              editor.setProperty(owner, key, call('BT_unurl', [expr], expr.range));
              state.stats.getUrl++;
            }
          },
        }), { walkMode: WalkMode.visitAllRecursive });
      }
      const inits = state.sceneInits.get(file.pkgPath);
      if (inits) {
        for (const fn of inits) {
          const body = fn.func.body;
          const idx = body.statements.findIndex((s) => !isCommentStatement(s));
          if (OPTS.sameLine && idx >= 0) editor.setProperty(body.statements, idx, new PrefixedStatement('BT_bootstrap(m.top)', body.statements[idx]));
          else editor.arrayUnshift(body.statements, new BareCallStatement('BT_bootstrap(m.top)', fn.func));
          state.stats.initPrepend++;
        }
      }
    },
    afterProgramTranspile() { if (OPTS.log) console.error('[bt-spike]', JSON.stringify(state.stats)); },
  };
};
