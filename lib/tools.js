'use strict';
const path = require('path');

// Resolve a bin script for a dependency, regardless of npm hoisting. We look for the package's
// package.json starting from the consumer cwd and this package's dir, then read its `bin` field.
function resolveBin(pkg, binName) {
  const pkgJson = require.resolve(`${pkg}/package.json`, {
    paths: [process.cwd(), __dirname, path.join(__dirname, '..')],
  });
  const dir = path.dirname(pkgJson);
  const bin = require(pkgJson).bin;
  const rel = typeof bin === 'string' ? bin : bin[binName] || bin[pkg] || Object.values(bin)[0];
  return path.join(dir, rel);
}

// Absolute path to a package's main module — used so bsc can load the rooibos plugin no matter
// where it's installed (hoisted in the consumer, or nested under this package for local linking).
function resolvePackageMain(pkg) {
  return require.resolve(pkg, {
    paths: [process.cwd(), __dirname, path.join(__dirname, '..')],
  });
}

module.exports = { resolveBin, resolvePackageMain };
