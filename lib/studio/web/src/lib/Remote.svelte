<script>
  import { api } from './api.js';
  let { onact } = $props();
  let busy = $state(false);

  async function press(key) {
    busy = true;
    try { await api.keypress(key); } finally { busy = false; }
    onact?.(key);
  }
</script>

<div class="remote" class:busy>
  <div class="dpad">
    <button class="up" onclick={() => press('Up')} aria-label="Up">▲</button>
    <button class="left" onclick={() => press('Left')} aria-label="Left">◀</button>
    <button class="ok" onclick={() => press('Select')} aria-label="Select">OK</button>
    <button class="right" onclick={() => press('Right')} aria-label="Right">▶</button>
    <button class="down" onclick={() => press('Down')} aria-label="Down">▼</button>
  </div>
  <div class="aux">
    <button onclick={() => press('Back')}>Back</button>
    <button onclick={() => press('Home')}>Home</button>
  </div>
</div>

<style>
  .remote { display: flex; align-items: center; gap: 22px; }
  .dpad {
    display: grid; grid-template-columns: repeat(3, 46px); grid-template-rows: repeat(3, 46px);
    gap: 4px; padding: 8px; border-radius: 18px;
    background: linear-gradient(180deg, #201a3d, #171332); border: 1px solid #35306a;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 10px 24px rgba(0,0,0,.4);
  }
  .dpad button { border: none; color: #d9d5ff; background: transparent; font-size: 14px; cursor: pointer; border-radius: 10px; }
  .dpad button:hover { background: rgba(124,108,255,.18); }
  .up { grid-area: 1 / 2; } .left { grid-area: 2 / 1; } .ok { grid-area: 2 / 2; } .right { grid-area: 2 / 3; } .down { grid-area: 3 / 2; }
  .ok { background: var(--color-violet); color: #0c0e14; font-weight: 700; font-size: 12px; }
  .ok:hover { background: #8f80ff; }

  .aux { display: flex; flex-direction: column; gap: 8px; }
  .aux button { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 10px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
  .aux button:hover { border-color: var(--color-violet); }
  .busy { opacity: .7; }
</style>
