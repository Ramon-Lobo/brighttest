# Network fault model

::: info At a glance
**What it is for:** making the app's HTTP calls fail the way a real device reports it.

**You will:**
- Pick a fault kind and its parameters
- Know the failure code the app sees
- Read fault results in tests

**First file to open:** your rules file ([Network fixtures](/writing-tests/http-fixtures))
:::

::: warning Source of the device codes
From a device run on a Roku Ultra (firmware 16.0.4), async `roUrlEvent` path. Unmeasured items say **not verified on device**. The fault kinds themselves were not device-checked; the hub column is hub behaviour, not a measured engine result.
:::

## Fault kinds

| Kind | What the hub does | Device failure code the app should see |
|---|---|---|
| `reset` | Destroys the socket before any response byte | `-52`, "Empty reply from server" |
| `timeout` | Sends status 200 headers and a few body bytes, then holds until the client gives up or `holdMs` passes | `-28`, "Operation too slow" (partial body), only if the app set `SetMinimumTransferRate`. Otherwise **no event at all** |
| `status` | Answers the given HTTP status (default `503`) with a short text body | That status as the response code. Body kept only with `RetainBodyOnError(true)` |
| `delayMs` (any rule, not a kind) | Waits, then answers as the rule says | Not a failure by itself |

### Parameters

| Key | Applies to | Meaning |
|---|---|---|
| `kind` | all | `timeout`, `reset` or `status`; anything else is rejected at load |
| `status` | `status` | Integer 100 to 599. Default `503` |
| `holdMs` | `timeout` | Hold time before closing. Default `120000`. 0 or more |
| `partialBytes` | `timeout` | Body bytes before holding. Default `16`; `0` = headers only |
| `delayMs` | any rule | Wait before answering. 0 or more |

Write a fault as `fault: "timeout"`, as `fault: { kind, status, holdMs, partialBytes }`, or flat with `kind:` beside the other keys. It can also be one entry of a `responses` sequence (fail the first call, succeed the second).

## What the app sees

### On device

As in the table, via `roUrlEvent`:

- A `timeout` is observable only with `SetMinimumTransferRate`, or the app's own timer calling `AsyncCancel`. `roUrlTransfer` has no total timeout, so otherwise the request never finishes.
- The synchronous API has no `GetResponseCode`; `GetFailureReason()` returns the async event's strings.

### Headless

The hub's wire behaviour is identical in both lanes, but the headless engine's reported code may differ from hardware. Treat `reset` and `timeout` as logic tests; use the device lane for fidelity. Headless codes are **not verified on device**.

## Reading the result in tests

| Outcome | In `BTNet_requests` | `net.error` event |
|---|---|---|
| `reset` / `timeout` fault | `source: "fault"`, `error: "fault:reset"` / `"fault:timeout"` | Yes, same kind |
| `status` fault | Logged like a mock: `source: "mock"`, no `error`. Assert on `status` | No |
| Unmatched request, default `fail` policy (not a fault rule) | Status `599` | Kind `unmatched` |

## Example

::: code-group
```json [Rules file]
{ "rules": [
  { "url": "**/v1/config", "fault": { "kind": "timeout", "holdMs": 8000 } },
  { "url": "**/v1/search*", "responses": [ { "fault": { "kind": "reset" } }, { "status": 200, "json": { "rows": [] } } ] },
  { "url": "**/v1/home*", "fault": { "kind": "status", "status": 503 }, "delayMs": 500 }
] }
```
```brightscript [Spec file]
BTNet_fault({ url: "https://api.example.test/v1/config", kind: "timeout", holdMs: 8000 })
BTNet_fault({ url: "https://api.example.test/v1/home*", kind: "status", status: 503 })
```
:::

On device the `timeout` rule ends the request only if the app has `SetMinimumTransferRate` or its own timer.

## Not verified on device

- Codes for `status` faults whose body the app did not retain, and for `timeout` with `partialBytes` `0`. (Measured: 500/404 with `RetainBodyOnError(true)`, and a stall with a partial body.)
- Headless engine codes for `reset` and `timeout`.
- Every fault kind end to end through the hub on hardware.

## Related

- [Network recipe](/guide/network-recipe): mock, observe, fault one endpoint

**Full guide:** [Network fault model](full:/guide/net-faults) — the original wording.
