<script>
  let { title, blurb, planned = [], inspired = '' } = $props();
</script>

<div class="page">
  <div class="phead">
    <h1>{title}</h1>
    <span class="soon">planned</span>
  </div>
  <p class="sub">{blurb}</p>
  <ul>
    {#each planned as p}<li>{p}</li>{/each}
  </ul>
  {#if inspired}<p class="insp">Inspiration: {inspired}</p>{/if}
</div>

<style>
  .page { padding: 28px 32px; max-width: 720px; }
  .phead { display: flex; align-items: center; gap: 12px; }
  h1 { font-family: var(--font-display); font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
  .soon { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-amber); border: 1px solid rgba(255,194,75,.35); border-radius: 999px; padding: 2px 10px; }
  .sub { color: var(--color-haze); margin: 12px 0 20px; line-height: 1.6; max-width: 60ch; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  li { padding: 12px 14px; border: 1px solid var(--color-line); border-radius: 10px; background: var(--color-panel); color: var(--color-text); font-size: 13px; }
  li::before { content: '→'; color: var(--color-violet); margin-right: 10px; }
  .insp { color: var(--color-haze); font-size: 12px; margin-top: 18px; }
</style>
