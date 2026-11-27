# Architecture

::: info At a glance
**What it is for:** a map of brighttest's parts. This page is a short pointer. The full page has the diagrams and
data flows.

**You will:**
- See the parts and where each one runs
- Find the page that explains each part in detail

**First page to open:** [Architecture](full:/architecture) (full version)
:::

## System overview

brighttest is a thin layer over BrighterScript, Rooibos and brs-node. Around that core it adds:

- an on-device UI lane (e2e)
- a debug-only instrumentation layer (network and state)
- Studio, a browser workbench
- an MCP agent surface
- adoption tooling (`assess`, skills)

Everything that drives, installs on or tests a Roku goes through one device lease. Read-only checks (`doctor`, the
MCP `device_doctor` tool, the e2e preflight) do not take it.

## Components

Each part and the page that explains how to use it:

| Part | Read |
|---|---|
| The Rooibos lanes: headless default (fast loop), headless coverage (`--coverage`), device (`--device`, the reference), cross-check (`--cross-check`), and how results are read (they fail closed) | [Headless vs device](/writing-tests/headless-vs-device) |
| Why one spec works in every lane: a suite compiles to a plain object that any runner can drive | [Anatomy](/writing-tests/anatomy) |
| The e2e lane: tests a running, already sideloaded app over ECP | [E2E](/e2e/) |
| Instrumentation and the hub: a debug-only build with an injected agent that talks to a hub | [Instrumented builds](/guide/instrument) |
| The device lease | [Sharing a device](/guide/device-lease) |
| Studio | [Studio](/guide/studio) |
| The agent surface (MCP) | [MCP](/guide/mcp) |
| Adoption: assess and skills | [Assess](/guide/assess), [Agent skills](/guide/agent-skills) |

<!-- covers: The Rooibos lanes -->
<!-- covers: Headless — default (fast loop) -->
<!-- covers: Headless coverage — `--coverage` (no device) -->
<!-- covers: Device — `--device` (the reference) -->
<!-- covers: Cross-check — `--cross-check` -->
<!-- covers: How results are read -->
<!-- covers: Why one spec works in every lane -->
<!-- covers: The e2e lane -->
<!-- covers: Instrumentation and the hub -->
<!-- covers: The device lease -->
<!-- covers: Studio -->
<!-- covers: The agent surface (MCP) -->
<!-- covers: Adoption: assess and skills -->

## What runs where

Headless lanes run in Node on your machine or CI. Device lanes, e2e, Studio, MCP device tools and sideloads need a
Roku on your network, under the lease. The full page has the diagram.

## Related

- [Motivation](/motivation): why it is built this way
- Design decisions and maintainer internals: [Maintainer pages](/maintainer-pages)

**Full guide:** [Architecture](full:/architecture)
