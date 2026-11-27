<script>
  import { onMount } from 'svelte';
  import { api } from '../api.js';
  import { sourceLabel, passwordText, tokenText, leaseText, prefKeys, resetPrefs, engineText, aboutText } from '../settings.js';

  let s = $state(null);
  let err = $state('');
  let check = $state(null); // { busy, ok, text, checks }
  let copied = $state(false);
  let prefs = $state([]);
  let save = $state(null); // { busy, ok, text }
  let resetMsg = $state('');

  async function load() {
    try { s = await api.settings(); err = s && s.error ? s.error : ''; }
    catch { err = 'settings unavailable'; }
    try { prefs = prefKeys(localStorage); } catch { prefs = []; }
  }
  onMount(load); // read once on open; no polling

  async function testConnection() {
    check = { busy: true };
    try {
      const r = await api.settingsCheck();
      if (!r.ok) check = { busy: false, ok: false, text: r.error || 'check failed', checks: [] };
      else if (!r.reachable) check = { busy: false, ok: false, text: `not reachable: ${r.error}`, checks: r.checks || [] };
      else check = { busy: false, ok: (r.checks || []).every((c) => c.ok), text: `${r.model || '?'} · firmware ${r.softwareVersion || '?'} · developer mode ${r.developerEnabled === null ? '?' : r.developerEnabled ? 'enabled' : 'disabled'} · ECP ${r.ecpSettingMode || '?'}`, checks: r.checks || [] };
    } catch (e) { check = { busy: false, ok: false, text: e.message, checks: [] }; }
  }
  async function saveHost() {
    save = { busy: true };
    try {
      const r = await api.saveProjectHost(s.device.host);
      save = r.ok ? { busy: false, ok: true, text: `Saved ROKU_HOST=${s.device.host} to ${r.wrote}` } : { busy: false, ok: false, text: r.error || 'save failed' };
      if (r.ok) await load();
    } catch (e) { save = { busy: false, ok: false, text: e.message }; }
  }
  function resetBrowserPrefs() {
    const removed = resetPrefs(localStorage, (m) => window.confirm(m));
    resetMsg = removed.length ? `Removed ${removed.length} preference${removed.length === 1 ? '' : 's'}.` : '';
    prefs = prefKeys(localStorage);
  }
  async function copyAbout() {
    try { await navigator.clipboard.writeText(aboutText(s)); copied = true; setTimeout(() => (copied = false), 1500); } catch { /* clipboard blocked */ }
  }
</script>

<div class="page" data-testid="settings-page">
  <div class="phead"><h1>Settings</h1><span class="ro">the effective settings, and where each came from</span></div>
  {#if err}<p class="msg" role="status">{err}</p>{/if}
  {#if s}
    <section>
      <h2>Device</h2>
      <dl>
        <dt>Target</dt><dd data-testid="settings-device-source">
          {#if s.device.target === 'none'}No device is set ({sourceLabel(s.device.source)}).
          {:else if s.device.target === 'simulator'}Simulator, from {sourceLabel('simulator')}.
          {:else if s.device.target === 'pool'}Device pool: {s.lease.pool.value.join(', ')}.
          {:else}<code>{s.device.host}</code>{#if s.device.name || s.device.model} ({[s.device.name, s.device.model].filter(Boolean).join(', ')}){/if}, from {sourceLabel(s.device.source)}.{/if}
        </dd>
        {#if s.device.projectDefault}<dt>Project default</dt><dd><code>{s.device.projectDefault}</code> in <code>.env</code>{#if s.device.projectDefault !== s.device.host} (differs from the current target){/if}</dd>{/if}
        <dt>Precedence</dt><dd>--host, then ROKU_HOST in the environment, then <code>.env</code>, then a single cached device. The Devices page changes the target for this session only.</dd>
      </dl>
      <div class="row">
        <button data-testid="settings-test-connection" aria-label="Test connection" onclick={testConnection} disabled={check?.busy || s.device.target !== 'device'} title={s.device.target === 'device' ? '' : 'needs a device target'}>{check?.busy ? 'Testing…' : 'Test connection'}</button>
        <button data-testid="settings-save-host" aria-label="Save as project default" onclick={saveHost} disabled={save?.busy || s.device.target !== 'device' || s.device.projectDefault === s.device.host} title={s.device.target !== 'device' ? 'needs a device target' : s.device.projectDefault === s.device.host ? 'already the project default' : 'writes ROKU_HOST to .env'}>{save?.busy ? 'Saving…' : 'Save as project default'}</button>
        {#if check && !check.busy}<span class="res" class:bad={!check.ok} role="status">{check.ok ? 'OK' : 'Problem'}: {check.text}</span>{/if}
      </div>
      {#if check && !check.busy}
        <ul class="fix">{#each check.checks.filter((c) => !c.ok) as c}<li><b>{c.id}</b>: {c.fix}</li>{/each}</ul>
      {/if}
      {#if save && !save.busy}<p class="res" class:bad={!save.ok} role="status" data-testid="settings-save-result">{save.ok ? 'OK' : 'Problem'}: {save.text}</p>{/if}
      <p class="hint">Save as project default writes only <code>ROKU_HOST</code> to <code>.env</code> and does not change the running target. It never asks for or stores the dev password.</p>
      <p class="hint">Test connection reads the device's info only. It does not take the device lease.</p>
    </section>

    <section>
      <h2>Dev password</h2>
      <p data-testid="settings-password-status">{passwordText(s.password)}</p>
      <p class="hint">The value is never shown. Set it with <code>--password</code>, <code>ROKU_PASSWORD</code> or <code>.env</code>.</p>
    </section>

    <section>
      <h2>Device lease</h2>
      <dl>
        <dt>enabled</dt><dd>{String(s.lease.enabled.value)} ({s.lease.enabled.source})</dd>
        <dt>wait</dt><dd>{leaseText(s.lease.wait)}</dd>
        <dt>maxHold</dt><dd>{leaseText(s.lease.maxHold)}</dd>
        <dt>studioIdle</dt><dd>{leaseText(s.lease.studioIdle)}</dd>
        <dt>studioYield</dt><dd>{leaseText(s.lease.studioYield)}</dd>
        <dt>pool</dt><dd>{s.lease.pool.value.length ? s.lease.pool.value.join(', ') : 'none'} ({s.lease.pool.source})</dd>
        <dt>Studio now</dt><dd>{s.lease.holding ? 'holds the device' : 'does not hold the device'}</dd>
      </dl>
      <p class="hint">Edit the <code>deviceLease</code> block of <code>brighttest.json</code>; flags and <code>BRIGHTTEST_LEASE_WAIT</code> win over it.</p>
    </section>

    <section>
      <h2>Instrument hub</h2>
      <p data-testid="settings-hub-status">{#if s.hub.up}Running{:else}Not running: {s.hub.reason}{/if}</p>
      <dl>
        <dt>address</dt><dd>{s.hub.host ? `${s.hub.host}:${s.hub.port}` : 'unavailable'}</dd>
        <dt>instrument.net</dt><dd>{s.hub.net ? 'on' : 'off'}</dd>
      </dl>
      <h3>Hub token</h3>
      <p data-testid="settings-token-status">BRIGHTTEST_HUB_TOKEN: {tokenText(s.hubToken)}</p>
      <p class="hint">The value is never shown. It comes from the process environment only.</p>
    </section>

    <section>
      <h2>Project</h2>
      <dl>
        <dt>root</dt><dd><code>{s.project.rootDir}</code></dd>
        <dt>flows</dt><dd><code>{s.project.flowsDir}</code></dd>
        <dt>config</dt><dd>{s.project.configFile ? s.project.configFile : 'no brighttest.json (defaults)'}</dd>
        <dt>port</dt><dd>{s.project.port}{s.project.portFallback ? ' (8700 was taken)' : ''}</dd>
        <dt>app</dt><dd>{s.project.app || 'none'}</dd>
        <dt>target</dt><dd>{s.project.target}</dd>
      </dl>
    </section>

    <section>
      <h2>Redaction</h2>
      <dl>
        <dt>state paths</dt><dd>{s.redaction.statePaths.length ? s.redaction.statePaths.join(', ') : 'none'} (<code>instrument.state.redact.paths</code>)</dd>
        <dt>network</dt><dd>{s.redaction.net === null ? 'unknown' : s.redaction.net ? 'on' : 'off'}</dd>
      </dl>
    </section>

    <section>
      <h2>This browser</h2>
      <p>{prefs.length ? `Saved Studio preferences: ${prefs.join(', ')}` : 'No saved Studio preferences.'}</p>
      <button class="ghost" data-testid="settings-reset-prefs" aria-label="Reset Studio preferences in this browser" onclick={resetBrowserPrefs} disabled={!prefs.length}>Reset Studio preferences in this browser</button>
      {#if resetMsg}<span class="res" role="status">{resetMsg}</span>{/if}
    </section>

    <section>
      <h2>About</h2>
      <dl>
        <dt>brighttest</dt><dd>{s.about.version}</dd>
        <dt>node</dt><dd>{s.about.node}</dd>
        {#each s.about.engines as e}<dt>{e.kind}</dt><dd>{engineText(e)}</dd>{/each}
        <dt>Studio UI</dt><dd>{s.about.uiBuilt ? 'built' : 'not built'}</dd>
      </dl>
      <button class="ghost" data-testid="settings-about-copy" aria-label="Copy about text" onclick={copyAbout}>{copied ? 'Copied' : 'Copy for a bug report'}</button>
    </section>
  {/if}
</div>

<style>
  .page { padding: 28px 32px; max-width: 780px; }
  .phead { display: flex; align-items: baseline; gap: 14px; }
  h1 { font-family: var(--font-display); font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
  .ro { font-size: 12px; color: var(--color-haze); }
  section { border: 1px solid var(--color-line); border-radius: 12px; background: var(--color-panel); padding: 14px 18px; margin: 14px 0; }
  h2 { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); margin: 0 0 8px; }
  h3 { font-size: 12px; margin: 12px 0 4px; }
  dl { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; margin: 0; font-size: 13px; }
  dt { color: var(--color-haze); }
  dd { margin: 0; overflow-wrap: anywhere; }
  p { margin: 6px 0; font-size: 13px; }
  code { font-family: var(--font-mono); color: #b7c0ff; font-size: 12px; }
  .hint { color: var(--color-haze); font-size: 12px; }
  .msg { color: var(--color-fail); font-family: var(--font-mono); font-size: 12px; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  button { background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
  button.ghost { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); font-weight: 400; margin-top: 8px; }
  button:disabled { opacity: .6; cursor: default; }
  .res { font-size: 12px; font-family: var(--font-mono); color: var(--color-pass); }
  .res.bad { color: var(--color-fail); }
  .fix { margin: 8px 0 0; padding-left: 18px; font-size: 12px; list-style: disc; display: block; }
</style>
