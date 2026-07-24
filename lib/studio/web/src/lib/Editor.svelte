<script>
  import { onMount } from 'svelte';
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';
  import { yaml } from '@codemirror/lang-yaml';
  import { autocompletion, completionKeymap, startCompletion } from '@codemirror/autocomplete';
  import { flowCompletions } from './completions.js';

  let { value = $bindable(''), getSelected } = $props();
  let el, view;

  const theme = EditorView.theme({
    '&': { color: 'var(--color-text)', backgroundColor: 'transparent', height: '100%', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
    '.cm-content': { caretColor: 'var(--color-violet)' },
    '.cm-cursor': { borderLeftColor: 'var(--color-violet)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#4c5266', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(124,108,255,.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-haze)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(124,108,255,.25) !important' },
    '.cm-tooltip': { backgroundColor: 'var(--color-panel2)', border: '1px solid var(--color-line2)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 30px rgba(0,0,0,.5)' },
    '.cm-tooltip-autocomplete ul li': { fontFamily: 'var(--font-mono)', padding: '4px 10px' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--color-violet)', color: '#0c0e14' },
    '.cm-completionDetail': { color: 'var(--color-haze)', fontStyle: 'normal', marginLeft: '1em' },
    '.cm-completionIcon': { opacity: .6 },
  }, { dark: true });

  const highlight = syntaxHighlighting(HighlightStyle.define([
    { tag: [t.keyword, t.definition(t.propertyName)], color: '#b9b1ff' },      // step / keys
    { tag: [t.propertyName, t.atom], color: '#9aa2ff' },
    { tag: t.string, color: '#7fd6a3' },                                       // values
    { tag: t.number, color: '#ffc24b' },
    { tag: t.bool, color: '#ffc24b' },
    { tag: t.comment, color: '#5b6178', fontStyle: 'italic' },
    { tag: t.punctuation, color: '#8a90a6' },
  ]));

  export function insert(text) {
    if (!view) return;
    const end = view.state.doc.length;
    const nl = end > 0 && view.state.doc.sliceString(end - 1) !== '\n' ? '\n' : '';
    const chunk = nl + '  ' + text + '\n';
    view.dispatch({ changes: { from: end, insert: chunk }, selection: { anchor: end + chunk.length } });
    view.focus();
  }

  onMount(() => {
    view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), history(),
          yaml(), highlight,
          autocompletion({ override: [flowCompletions(getSelected)], activateOnTyping: true, icons: false }),
          keymap.of([indentWithTab, ...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => { if (u.docChanged) value = u.state.doc.toString(); }),
          theme,
        ],
      }),
    });
    return () => view?.destroy();
  });

  // Sync external value changes (opening a different flow) into the editor.
  $effect(() => {
    const v = value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });
</script>

<div bind:this={el} class="editor"></div>

<style>
  .editor { height: 100%; overflow: hidden; }
  .editor :global(.cm-editor) { height: 100%; }
  .editor :global(.cm-editor.cm-focused) { outline: none; }
</style>
