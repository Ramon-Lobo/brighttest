# Package size limit

Evidence labels: **researched** = read from Roku's public docs by the researcher (note ADOPT-15, 2026-11-22), not
re-checked here; **verified** = checked in this repo or measured here; **unconfirmed** = not stated by Roku.

## The limit (researched, external docs)

- Roku certification requirement 3.7: the app's file size must be 4 MB or less
  (https://developer.roku.com/dev/docs/certification and https://developer.roku.com/dev/docs/cert-tests).
- The Static Analysis tool reports it as an error, "Package size exceeds N megabytes" (requirement 3.7), and errors
  block certification
  (https://developer.roku.com/docs/developer-program/certification/cert-tests/static-analysis-tool.md).
- Zipped or unzipped: **unconfirmed**. Roku's text does not say. A community answer says the zip size
  (https://community.roku.com/t5/Roku-Developer-Program/Maximum-Channel-Size-pre-or-post-zip/td-p/217870, seen only as
  a search snippet). MB or MiB: **unconfirmed**.
- This is a certification (publish) limit. Whether sideloading to a dev device is blocked by it is **unconfirmed**
  (needs a device).

## The budget to use

Measure the zipped package and keep it under **4,000,000 bytes** (the stricter reading). Recipe, same in bash and zsh:

```bash
size=$(wc -c < build/store.zip | tr -d ' ')
if [ "$size" -le 4000000 ]; then echo "size ok: $size bytes"; else echo "OVER BUDGET: $size bytes"; fi
```

Run it on the release package, after `instrument verify` exits 0. Then say in the report: the byte count, the
budget, and that the limit is from Roku docs and unconfirmed for zip versus unzipped.

## What brighttest does about size (verified)

- Nothing checks or reports package size today: no size check exists in `lib/instrument/`, and `instrument build`
  output has no size line. You measure it yourself.
- Instrumentation adds the runtime files (`components/bt/*`, `source/bt/*`), per-file probes and a `BT_op`
  declaration per component chain. Measured here on `examples/legacy-app` (a fixture, not your app): the plain
  package is 38,326 bytes zipped and 34,229 unzipped; the instrumented one is 53,277 zipped and 107,729 unzipped.
  Your numbers will differ. The design notes quote a runtime figure of about 58 KB; that is not re-measured here
  (unverified).
- For a real app, images, audio and fonts normally dominate size (general knowledge, unverified for your app).
  `instrument.exclude` limits probes only; it does not shrink assets.

## Never ship the instrumented zip

The instrumented package is for test lanes. Never certify or publish it and never use its size as the release
figure. Build the release package from the original sources (without `instrument build`), run
`npx brighttest instrument verify` on it (must exit 0), then measure it.
