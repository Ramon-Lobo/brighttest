<script>
  let { title, label = '', placeholder = '', initial = '', confirmLabel = 'OK', password = false, onsubmit, oncancel } = $props();
  let value = $state(initial);
  let inputEl;
  $effect(() => { inputEl?.focus(); inputEl?.select(); });
  const submit = () => onsubmit((value ?? '').trim());
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') oncancel(); }} />
<div class="overlay" role="presentation" onpointerdown={oncancel}>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1" onpointerdown={(e) => e.stopPropagation()}>
    <h2>{title}</h2>
    {#if label}<label for="pm-input">{label}</label>{/if}
    <input id="pm-input" bind:this={inputEl} bind:value {placeholder} type={password ? 'password' : 'text'}
      onkeydown={(e) => { if (e.key === 'Enter') submit(); }} />
    <div class="row">
      <button class="ghost" onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={submit}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgba(8,9,13,.6); backdrop-filter: blur(3px); }
  .modal {
    width: min(420px, calc(100vw - 40px)); background: var(--color-panel2); border: 1px solid var(--color-line2);
    border-radius: 14px; padding: 20px; box-shadow: 0 30px 70px rgba(0,0,0,.6);
  }
  h2 { font-family: var(--font-display); font-size: 16px; font-weight: 700; margin: 0 0 14px; }
  label { display: block; font-size: 12px; color: var(--color-haze); margin-bottom: 6px; }
  input {
    width: 100%; box-sizing: border-box; background: #10131c; color: var(--color-text);
    border: 1px solid var(--color-line2); border-radius: 9px; padding: 10px 12px;
    font-family: var(--font-mono); font-size: 13px;
  }
  input:focus { outline: none; border-color: var(--color-violet); }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .ghost { background: transparent; color: var(--color-haze); border: 1px solid var(--color-line2); border-radius: 8px; padding: 8px 16px; cursor: pointer; }
  .ghost:hover { color: var(--color-text); border-color: var(--color-haze); }
  .primary { background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 8px 18px; cursor: pointer; }
  .primary:hover { background: #8f80ff; }
</style>
