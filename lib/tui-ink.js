'use strict';

// The only module that imports `ink` (and `react`). Both are optionalDependencies and ESM-only, so they are
// loaded lazily with a dynamic import() and only when the live `device watch` screen is chosen. A missing or
// broken install is reported as { error }, never thrown: the caller falls back to the plain live view.
//   importer(name) -> Promise<module>   injected by tests; the default is the real import()

async function loadInk({ importer = (m) => import(m) } = {}) {
  try {
    const ink = await importer('ink');
    const reactMod = await importer('react');
    const React = (reactMod && reactMod.default) || reactMod;
    const ok = ink && typeof ink.render === 'function' && ink.Box && ink.Text && React && typeof React.createElement === 'function';
    if (!ok) {
      return { error: new Error('ink or react did not load as expected') };
    }
    return { ink, React };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

module.exports = { loadInk };
