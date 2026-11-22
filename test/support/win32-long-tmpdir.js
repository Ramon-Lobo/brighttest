// win32 runners hand out an 8.3 short temp path (C:\Users\RUNNER~1\...). bsc relates rootDir to the real
// (long) path of the files it copies, so a short rootDir makes it fail with "Referenced file does not exist"
// and nothing is staged. Point the temp env at the long path before any test (and any child) reads it.
if (process.platform === 'win32') {
  const long = require('node:fs').realpathSync.native(require('node:os').tmpdir())
  process.env.TEMP = long
  process.env.TMP = long
}
