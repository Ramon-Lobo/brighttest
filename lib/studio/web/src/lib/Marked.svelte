<script>
  // Text with the search matches wrapped in <mark> (text only, never HTML).
  import { highlight } from './statetree.js';
  let { text = '', search = null } = $props();
  const parts = $derived(search && search.query ? highlight(text, search.query, !!search.caseSensitive) : [{ text: String(text ?? ''), mark: false }]);
</script>{#each parts as s}{#if s.mark}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}

<style>
  mark { background: rgba(255, 210, 0, 0.45); color: inherit; border-radius: 2px; }
</style>
