// Reactive search state shared by one search bar and the trees under it (the State tab layers, or one node view).
// The matching itself is pure and lives in statetree.js; this only holds the query, the toggles and the current match.
import { combineMatches, locateCurrent, stepIndex, sameList } from './statetree.js';

export function createStateSearch() {
  let query = $state('');
  let caseSensitive = $state(false);
  let filter = $state(false);
  let order = $state.raw([]);   // layer keys in display order
  let byKey = $state.raw({});   // layer key -> that tree's matches
  let cur = $state.raw(null);   // { key, path } the user stepped to; null means the first match
  let last = 0;                 // index to clamp to when the current match vanished

  const all = $derived(combineMatches(order, byKey));
  const index = $derived(locateCurrent(all, cur, last));
  const curKey = $derived(index >= 0 ? all[index].key : null);
  const curPath = $derived(index >= 0 ? all[index].path : null);

  return {
    get query() { return query; },
    set query(v) { query = v; cur = null; last = 0; },
    get caseSensitive() { return caseSensitive; },
    set caseSensitive(v) { caseSensitive = v; cur = null; last = 0; },
    get filter() { return filter; },
    set filter(v) { filter = v; },
    get total() { return all.length; },
    get index() { return index; },
    setOrder(keys) { if (!sameList(order, keys)) order = keys; },
    report(key, list) { if (!sameList(byKey[key] || [], list)) byKey = { ...byKey, [key]: list }; },
    step(dir) {
      if (!all.length) return;
      last = stepIndex(all.length, index, dir);
      cur = all[last];
    },
    // The `search` prop for the tree under `key` (null while there is no query).
    searchFor(key) {
      if (!query) return null;
      return { query, caseSensitive, mode: filter ? 'filter' : 'highlight', current: curKey === key ? curPath : null };
    },
  };
}
