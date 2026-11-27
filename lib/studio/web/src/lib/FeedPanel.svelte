<script>
  // Screen source: device screenshots (default) or a browser capture-card feed (getUserMedia) with per-feed calibration.
  // `feed` is { stream, deviceId, label, rect, auto, ready, w, h } while a feed is live, else null. App turns screenshots off for it.
  import { onMount, onDestroy } from 'svelte';
  import { studio } from './store.svelte.js';
  import { autoRect, applyNudge, loadCal, saveCal, loadLastFeed, saveLastFeed, friendlyError } from './feed.js';

  let { feed = $bindable(null), calibrating = $bindable(false) } = $props();
  let devices = $state([]);
  let msg = $state('');
  let busy = $state(false);
  let timer = null;
  const store = typeof localStorage === 'undefined' ? null : localStorage;
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const needsGrant = $derived(devices.length > 0 && devices.some((d) => !d.label));

  async function listDevices() {
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId); } catch { devices = []; }
  }
  function stopStream(s) { try { s?.getTracks().forEach((t) => t.stop()); } catch {} }
  function stop(message = '') {
    clearTimeout(timer); timer = null;
    if (feed) { stopStream(feed.stream); }
    feed = null; calibrating = false; saveLastFeed(store, null);
    msg = message;
  }
  // Allow camera access: one short grant so the device labels appear, then release it.
  async function allow() {
    msg = '';
    try { const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); stopStream(s); await listDevices(); }
    catch (e) { msg = friendlyError(e?.name); }
  }
  async function pick(deviceId) {
    if (busy) return;
    if (!deviceId) { stop(''); return; }
    busy = true; msg = '';
    const prev = feed; 
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } }, audio: false });
      if (prev) { stopStream(prev.stream); }
      clearTimeout(timer);
      const track = stream.getVideoTracks()[0];
      const st = track?.getSettings?.() || {};
      const label = track?.label || devices.find((d) => d.deviceId === deviceId)?.label || '';
      const saved = store ? loadCal(store, deviceId) : null;
      const f = { stream, deviceId, label, w: st.width || 0, h: st.height || 0, rect: saved ? saved.C : autoRect(st.width, st.height), auto: saved ? saved.auto : true, ready: false };
      feed = f;
      saveLastFeed(store, deviceId);
      track?.addEventListener('ended', () => { if (feed && feed.stream === stream) stop('The feed stopped (capture device unplugged?). Back to device screenshots.'); });
      // The first frames of a card are often its own splash: wait about 2 s before trusting the frame size.
      timer = setTimeout(() => {
        if (!feed || feed.stream !== stream) return;
        const s2 = track?.getSettings?.() || {};
        feed = { ...feed, w: s2.width || feed.w, h: s2.height || feed.h, rect: saved ? feed.rect : autoRect(s2.width || feed.w, s2.height || feed.h), ready: true };
      }, 2000);
      await listDevices();
    } catch (e) {
      msg = friendlyError(e?.name) + ' Using device screenshots.';
      if (!prev) feed = null;
    } finally { busy = false; }
  }
  function persist() { if (feed && store) saveCal(store, feed.deviceId, { label: feed.label, C: feed.rect, auto: feed.auto }); }
  function nudge(n) {
    if (!feed) return;
    feed = { ...feed, rect: applyNudge(feed.rect, studio.scene, n), auto: false };
    persist();
  }
  function resetAuto() {
    if (!feed) return;
    feed = { ...feed, rect: autoRect(feed.w, feed.h), auto: true };
    persist();
  }

  onMount(async () => {
    if (!supported) return;
    await listDevices();
    // Reopen the last feed only when the camera permission is already granted and the device is still there (no prompt on load).
    const last = loadLastFeed(store);
    if (!last || !devices.some((d) => d.deviceId === last)) return;
    try { const p = await navigator.permissions?.query({ name: 'camera' }); if (p?.state === 'granted') await pick(last); } catch {}
  });
  onDestroy(() => { clearTimeout(timer); });
</script>

{#if supported}
<div class="feedsrc" data-testid="feed-panel">
  <label class="fl" for="feed-source-select">Screen source</label>
  <select id="feed-source-select" data-testid="feed-source" aria-label="Screen source" value={feed?.deviceId || ''} disabled={busy} onchange={(e) => pick(e.currentTarget.value)}>
    <option value="">Device screenshots</option>
    {#each devices as d, i (d.deviceId)}<option value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>{/each}
  </select>
  {#if !devices.length || needsGrant}
    <button type="button" class="mini" data-testid="feed-allow" onclick={allow}>Allow camera access</button>
  {/if}
  {#if feed}
    <span class="st" data-testid="feed-status" role="status">{feed.ready ? `live ${feed.w || '?'}x${feed.h || '?'}` : 'waiting for signal'}</span>
    <button type="button" class="mini" data-testid="feed-calibrate" aria-expanded={calibrating} onclick={() => (calibrating = !calibrating)}>Calibrate</button>
    {#if calibrating}
      <span class="cal" data-testid="feed-calibrate-panel" role="group" aria-label="Feed calibration">
        <button type="button" class="mini" data-testid="feed-nudge-left" aria-label="Move picture left" onclick={() => nudge({ dx: -10 })}>←</button>
        <button type="button" class="mini" data-testid="feed-nudge-right" aria-label="Move picture right" onclick={() => nudge({ dx: 10 })}>→</button>
        <button type="button" class="mini" data-testid="feed-nudge-up" aria-label="Move picture up" onclick={() => nudge({ dy: -10 })}>↑</button>
        <button type="button" class="mini" data-testid="feed-nudge-down" aria-label="Move picture down" onclick={() => nudge({ dy: 10 })}>↓</button>
        <button type="button" class="mini" data-testid="feed-scale-up" aria-label="Zoom picture in" onclick={() => nudge({ sw: -1, sh: -1 })}>+</button>
        <button type="button" class="mini" data-testid="feed-scale-down" aria-label="Zoom picture out" onclick={() => nudge({ sw: 1, sh: 1 })}>−</button>
        <button type="button" class="mini" data-testid="feed-reset-auto" onclick={resetAuto}>Reset to auto</button>
        <span class="st" data-testid="feed-rect">{feed.auto ? 'auto' : 'manual'}: {Math.round(feed.rect.x * 1000) / 10}, {Math.round(feed.rect.y * 1000) / 10}, {Math.round(feed.rect.w * 1000) / 10} x {Math.round(feed.rect.h * 1000) / 10} %</span>
      </span>
    {/if}
  {/if}
  {#if msg}<span class="err" data-testid="feed-message" role="status">{msg}</span>{/if}
</div>
{/if}

<style>
  .feedsrc { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-haze); flex-wrap: wrap; }
  .cal { display: inline-flex; align-items: center; gap: 4px; }
  select { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 6px; padding: 3px 6px; font-size: 12px; max-width: 200px; }
  .mini { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
  .mini:hover { border-color: var(--color-violet); }
  .st { font-family: var(--font-mono); font-size: 11px; }
  .err { color: var(--color-amber); max-width: 360px; }
</style>
