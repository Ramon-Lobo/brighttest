<script>
  import { studio } from '../store.svelte.js';
  import { api } from '../api.js';
  let { onconnected, askPassword } = $props();

  const dev = $derived(studio.device);
  let list = $state([]);
  let scanning = $state(false);
  let msg = $state('');
  let connecting = $state(null); // host being connected

  async function scan() {
    scanning = true; msg = '';
    try { list = await api.discover(); if (!list.length) msg = 'No Rokus found on this network.'; }
    catch { msg = 'discovery failed'; } finally { scanning = false; }
  }

  async function connect(d) {
    let password = null;
    if (!d.hasPassword) {
      password = await askPassword(d);
      if (password == null) return; // cancelled
    }
    connecting = d.host; msg = '';
    try {
      const r = await api.connect(d.host, password);
      if (r.error) msg = r.error;
      else { await onconnected?.(); await scan(); }
    } catch (e) { msg = e.message; } finally { connecting = null; }
  }
</script>

<div class="page">
  <div class="phead"><h1>Devices</h1><button class="ghost" onclick={scan} disabled={scanning}>{scanning ? 'Scanning…' : 'Discover'}</button></div>

  <div class="current">
    <span class="dot" class:on={dev?.connected}></span>
    {#if dev?.connected}
      <div><div class="model">{dev.model}</div><div class="meta">{dev.host} · fw {dev.firmware}</div></div>
      <span class="badge">connected</span>
    {:else}
      <div><div class="model">No device connected</div><div class="meta">Discover a Roku below, or pass <code>--host</code> / set <code>ROKU_HOST</code>.</div></div>
    {/if}
  </div>

  {#if msg}<p class="msg">{msg}</p>{/if}

  {#if list.length}
    <div class="eyebrow">on this network</div>
    <ul>
      {#each list as d}
        <li>
          <span class="ddot" class:on={d.host === dev?.host && dev?.connected}></span>
          <div class="dinfo"><span class="dname">{d.name}</span><span class="dmeta">{d.model} · {d.host}</span></div>
          {#if d.hasPassword}<span class="cached">password cached</span>{/if}
          <button class="connect" onclick={() => connect(d)} disabled={connecting === d.host}>
            {connecting === d.host ? 'Connecting…' : d.host === dev?.host && dev?.connected ? 'Reconnect' : 'Connect'}
          </button>
        </li>
      {/each}
    </ul>
  {:else if !scanning}
    <p class="hint">Hit <b>Discover</b> to find Rokus on your network. If one isn't cached, you'll be asked for its dev password once.</p>
  {/if}
</div>

<style>
  .page { padding: 28px 32px; max-width: 780px; }
  .phead { display: flex; align-items: center; justify-content: space-between; }
  h1 { font-family: var(--font-display); font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
  .ghost { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
  .ghost:hover:not(:disabled) { border-color: var(--color-violet); }
  .ghost:disabled { opacity: .55; cursor: default; }

  .current { display: flex; align-items: center; gap: 14px; padding: 16px; border: 1px solid var(--color-line); border-radius: 12px; background: var(--color-panel); margin: 16px 0; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--color-line2); }
  .dot.on { background: var(--color-pass); box-shadow: 0 0 10px var(--color-pass); }
  .model { font-weight: 600; }
  .meta { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); margin-top: 2px; }
  .meta code { color: #b7c0ff; }
  .badge { margin-left: auto; font-size: 11px; color: var(--color-pass); border: 1px solid rgba(69,212,131,.4); border-radius: 999px; padding: 2px 10px; }
  .msg { color: var(--color-fail); font-family: var(--font-mono); font-size: 12px; }

  .eyebrow { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); margin: 6px 0 8px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--color-line); border-radius: 10px; background: var(--color-panel); }
  .ddot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-line2); flex: none; }
  .ddot.on { background: var(--color-pass); }
  .dinfo { display: flex; flex-direction: column; flex: 1; }
  .dname { font-weight: 600; }
  .dmeta { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); }
  .cached { font-size: 11px; color: var(--color-haze); }
  .connect { background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
  .connect:hover:not(:disabled) { background: #8f80ff; }
  .connect:disabled { opacity: .6; cursor: default; }
  .hint { color: var(--color-haze); }
</style>
