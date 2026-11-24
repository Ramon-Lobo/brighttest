# Design decisions

The main architecture choices behind brighttest, each with the reason it was made and what it costs. The
[Architecture](/architecture) page describes how the parts fit; this page explains why they are shaped that way.
[Motivation & decisions](/motivation) covers the earlier choice of tools.

## Toolchain and engines

**Engines are forks published as packages, moving to small patch queues on upstream tags.** brighttest depends on forked
`brs-node` and `rooibos-roku` packages instead of patching or vendoring at install time. Patching on install broke
under hoisted installs and minified bundles; a fork with a short, documented list of patches on an exact upstream tag
can be rebased, reviewed and offered upstream one patch at a time. The forks are being rebuilt that way; until those
releases are published, brighttest depends on the earlier fork releases. brighttest already resolves patched or stock
engines, and `doctor --engines` says which it found. Cost: publishing depends on the fork maintainer, and a fork patch that
has no device equivalent can make a headless pass that a device would not reproduce; cross-check exists to catch that.

**Engine and framework fixes go in the forks, even when brighttest ships a guard first.** A guard in brighttest may
stop a false result (see "Results fail closed" below), but it never replaces the fix in the fork. Upstream proposals
are drafted in batches per project and posted by a maintainer.

**No dependency on Roku's own SDK at runtime; Node 22, plain CommonJS, no build step.** The CLI must install with
`npm i -D` and run anywhere Node runs. Interop with other Roku tools happens across process boundaries. Adding a
runtime dependency needs a written decision; where a small, well-understood piece was needed (an MCP server, an HTTP
Digest client, a YAML subset, a Perfetto protobuf decoder) it was written on Node core.

## Results

**Results fail closed.** In the lanes that use the Rooibos runner (the default lane with `@SGNode` specs, `--coverage`,
`--device`, `--cross-check`), a run fails when any of the streamed cases, the Rooibos summary or the Rooibos report
tree shows a failure or crash. The SceneGraph-off driver prints its own per-test lines and a total, and a run without
that total fails. This came from a framework path that dropped a `beforeEach` crash from the summary while still
printing it in the tree. Counting the largest of the three, never their sum, avoids double counting. Cost: the runner
reads Rooibos's report text, so a format change in Rooibos needs a matching change here.

**Launch readiness and crash classification are explicit.** The e2e lane waits for the app to be active and answering
before the first step, and distinguishes "crashed", "not launched" and "maybe launched", so a flaky launch is not
reported as an app bug and a crash is never reported as a pass.

## Device access

**One lease per device, implemented with lock files, no daemon.** Several tools, people and agents share a small number
of devices; two of them driving one Roku at once produces nonsense results. Everything that drives a Roku, installs on
it or runs tests on it takes the lease; read-only checks (`doctor`, the MCP `device_doctor` tool, the e2e preflight)
do not. A per-user lock directory with a holder
file, FIFO tickets and crash recovery is enough on one machine and needs nothing running in the background. Cost: it
coordinates processes of one user on one machine; a shared lab across machines would need a broker behind the same
interface.

**Session leases belong to no process.** Multi-step work (an agent between commands, the MCP network window) has no
single process that lives for the whole stretch, so a session lease expires on idle time and a hard cap instead of a
process check. Holders that keep their own view of a session close it before the record could expire, so two holders
never both believe they own the device. Cost: a holder that vanishes blocks the device until the idle time runs out.

**Hygiene is cheap and targeted.** `e2e run`, `device with` and `device lock` press Home twice after taking the lease
(configurable, `--no-hygiene` to skip), so a run starts from a known screen; the Rooibos device lane presses Home once
before deploy. Tools that work on what is on screen (Studio, MCP, `e2e inspect` and `record`) and commands that manage
the screen themselves (`device reset`, sideload) do not. Re-entering a session does not either, because multi-step
debugging depends on the current screen, with one exception: an `e2e run` that starts a fresh hub presses Home so a
resident app relaunches and connects to it.

**Keep-alive is a host-side keypress, opt-in.** Long runs could stall after about ten minutes without input. A periodic
`Fwd` keypress from the host was the one approach with hardware evidence; it changes no device setting and moves no
focus. Relaunching the app on a stall was rejected as a default because it resets state and hides the problem.

**Agents reach devices only through the lease.** The CLI leases itself; bundled guidance tells agents to use it; an
optional hook denies raw device commands that carry no lease token. The hook is a guard rail, not a sandbox: it cannot
see into scripts or variables, so the guidance and the CLI do most of the work.

**Credentials come from the environment.** The device password is read from `ROKU_PASSWORD` (or the project's local
device configuration), is never printed or logged, and tracked files use a placeholder. Commands that agents type
never need a password literal.

## Instrumentation

**One debug-only, staged-copy build for every on-device hook.** Network interception and state access need code in the
app. Putting it in the user's source tree would leak into releases; one bsc plugin applied to a staged copy keeps the
source untouched, and a release gate (`instrument verify`) finds any marker in a package. The plugin keeps line numbers
by rewriting on the same line, reports what it cannot rewrite safely instead of guessing, and runs after the Rooibos
coverage processor so coverage stays correct.

**The device dials home.** A Roku app cannot usefully host a server for a test machine, and opening ports on a device
is a security problem. The injected agent connects out to a hub on the developer machine, which runs only while its
device lease is held, accepts only that device and a known token (the build's own, or the operator token
`BRIGHTTEST_HUB_TOKEN` that a `--net` build bakes in), and answers everything else with an empty 404.

**Network interception by URL rewrite, the same headless and on device.** Rewriting `setUrl` call sites to go through
the hub needs no engine hook and behaves identically on the simulator and the device, so a mock written for a headless
spec means the same thing in an e2e flow. An engine-level interceptor is offered upstream only. Cost: requests that do
not go through a rewritten `setUrl` are not covered, and the render thread on some firmware cannot create
`roUrlTransfer`, so URLs built there pass through unchanged; build them in a Task. The build report flags such calls.

**The injected runtime has a size budget.** The agent ships inside the app package, so it is kept small: explanations
live in a README next to the runtime rather than in the shipped BrightScript, and staging strips comments and blank
lines. Raising the budget was rejected in favour of moving text out.

**State access is allow-listed, typed and redacted at the source.** The agent accepts a fixed set of operations, checks
types on every write, refuses payloads over 64 KB instead of truncating them, and masks secret-looking keys and
configured paths on the agent's `get` and snapshot reads before data leaves the app (action-log payloads are masked by
key name on the device and by configured paths on the host). Studio's raw views and fixtures saved as raw skip
Studio's own masking by design, for a person who asks for them; the agent's masking still applies. A component's private `m` is reached through a
function injected into that component, the only supported way to run code in its scope. Task state is captured at
Task entry and exit only, because a Task blocked in `wait()` cannot be interrupted without changing the app; apps can
add guarded manual snapshots. Action logs and time travel exist only where the app has a dispatch function to wrap.

**Run artefacts keep timing, not app data.** The hub events file in a run's output keeps only timing-relevant keys from
agent events, so CI artefacts do not carry app state.

## Tools on top

**Studio is a local server with a strict security baseline.** It binds to loopback, accepts only its own Host and
Origin, and takes mutations as JSON only (the one exception is the `.bsprof` profile import, sent as
`application/octet-stream`), so a web page in the same browser cannot drive a device through it. Heavy
work such as Perfetto trace parsing runs in a worker thread with bounded memory, so a large trace cannot take the
server down.

**The agent surface is MCP over stdio, deterministic, with no model inside.** brighttest exposes the same primitives the
e2e lane uses. The agent decides; brighttest executes, under the lease, with per-session caps. No tool accepts a host,
password or absolute path; `run_flow` takes a project-relative path with no `..`, so an agent cannot point a tool at an
arbitrary device or file.

**`doctor` tells what it proved.** By default it reads device capability without a password or lease and says that
device-to-hub reach is unproven. An opt-in probe takes the lease, sideloads a tiny probe channel (replacing the dev channel,
which it says) and confirms the device can reach the hub. A probe that could not run reports "not tested" without
failing the command.

## Adoption

**Adoption logic lives in the CLI; skills are prose.** Anything that must be correct (scanning a project, finding
blockers, counting files) is a command (`brighttest assess`) with tests. Skills explain when and how to use commands.
A facts file generated from the CLI gates the skill text, so a skill cannot claim a flag, exit code or default that
does not exist.

**Reading someone else's project is treated as untrusted input.** `assess` and the census read through one helper that
does not follow symlinks, checks the identity of what it opened, caps sizes, never opens `.env`, key or certificate
files, and redacts absolute paths in its output. It is offline and read-only.

**Skills install folder-first, with an always-on safety block.** One canonical skill source is adapted to each agent's
conventions. A short managed block in the agent's always-on instruction file carries the rules that must apply even
when no skill is loaded (use the lease, never print secrets, never edit without permission). The device guard hook and
the MCP entry are merged only when asked for.

**Skills are evaluated with real agent runs.** A harness prepares fixture copies and prompts and scores the results; it
never launches an agent or calls a model API itself. Runs are made by fresh agent sessions with and without the skills,
three per cell, and a criterion passes at two of three. The results are labelled with how they were produced, and their
limits (small N, shared configuration, inlined skill text) are documented.

## Platforms

**Windows: fix path handling first, then a unit-only CI job.** Package paths and test helpers use forward slashes and
platform-neutral spawning. Windows runs the unit suite in CI; the integration and device lanes are not exercised on
Windows.
