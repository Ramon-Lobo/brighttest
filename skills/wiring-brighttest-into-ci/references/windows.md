# Windows

Stance: macOS and Linux are the supported hosts for brighttest.

- Headless lane on Windows: best-effort and unverified for user projects. This repo runs only its own unit suite on
  `windows-latest`, as a non-required job (`continue-on-error: true`, Node 22, `shell: bash` for the test step, and
  `git config --global core.autocrlf false` first so files keep LF line endings; see `.github/workflows/test.yml`).
- Device lanes, `e2e`, Studio and the device lease are not claimed on Windows. Do not add a Windows device job and
  do not say they work there.
- The release gate (`instrument verify`) and the headless gate are not verified on Windows either. Run them on
  `ubuntu-latest`.

## What to do

- Put the brighttest jobs on `runs-on: ubuntu-latest` (or macOS). A Windows developer machine can still push to
  them.
- If the human insists on a Windows job, add it as a separate, non-required job (`continue-on-error: true`) with
  the same two lines as this repo: set `core.autocrlf` to false before checkout, and run the test step under
  `shell: bash`. Label it best-effort in the report.
- Shell snippets in these skills are POSIX. No PowerShell equivalents are given: no command here was verified in a
  PowerShell session, and the Windows CI job runs only the unit suite through bash.
