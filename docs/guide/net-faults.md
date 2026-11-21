# Network fault model

Fault rules let a test make the app's HTTP calls fail the way a real device reports it. This page lists each fault
kind, its parameters, what the app sees, and the device failure codes. For the rule format, `BTNet_*` calls and the
rest of the network fixtures, see [Network fixtures](/writing-tests/http-fixtures).

Device codes come from the device verification run on a Roku Ultra (firmware 16.0.4), using the async
`roUrlEvent` path. Anything that run did not measure is marked **not verified on device**. Device checks of the
fault kinds themselves (TP-NET-27) are still open, and the headless column below describes the hub's behavior, not a
measured engine result.

## Fault kinds

| Kind | What the hub does | Device failure code the app should see |
|---|---|---|
| `reset` | Destroys the socket before any response byte. | `-52`, "Empty reply from server" |
| `timeout` | Sends status 200 headers and a few body bytes, then holds the response until the client gives up or `holdMs` passes. | `-28`, "Operation too slow" (partial body delivered), only if the app set `SetMinimumTransferRate`. Otherwise **no event at all**. |
| `status` | Answers with the given HTTP status (default `503`) and a short text body. | The HTTP status, as the response code. The body is kept only when the app called `RetainBodyOnError(true)`. |
| `delayMs` (any rule, not a kind) | Waits before answering, then answers as the rule says. | Not a failure by itself. |

### Parameters

| Key | Applies to | Meaning |
|---|---|---|
| `kind` | all | `timeout`, `reset` or `status`. Anything else is rejected when the rule loads. |
| `status` | `status` | Integer 100 to 599. Default `503`. |
| `holdMs` | `timeout` | How long to hold the response before closing it. Default `120000`. Must be 0 or more. |
| `partialBytes` | `timeout` | Body bytes sent before holding. Default `16`. `0` sends headers only. |
| `delayMs` | any rule | Wait before answering. Must be 0 or more. |

A rule can write the fault as `fault: "timeout"`, as `fault: { kind, status, holdMs, partialBytes }`, or flat with
`kind:` next to the other keys. A fault can also be one entry of a `responses` sequence, for example to fail the
first call and succeed on the second.

## What the app sees

### On device

The app sees what the table above says, through its `roUrlEvent`. Two points matter when you write the app side:

- A `timeout` fault is only observable if the app set `SetMinimumTransferRate`, or runs its own timer and calls
  `AsyncCancel`. `roUrlTransfer` has no built-in total timeout, so without one of these the request never finishes.
- The synchronous API has no `GetResponseCode`. `GetFailureReason()` returns the same strings as the async event.

### Headless

The hub produces the same on-the-wire behavior in both lanes (socket destroyed, held response, plain status). The
response code the headless engine then reports to the app may differ from hardware, so treat `reset` and `timeout`
as logic tests and use the device lane for fidelity. The exact headless codes are **not verified on device** and not
checked against hardware here.

## Reading the result in tests

- `BTNet_requests` entries for `reset` and `timeout` faults have `source: "fault"` and `error: "fault:reset"` or
  `"fault:timeout"`. The hub also emits a `net.error` event with the same kind.
- A `status` fault is logged like a mock: `source: "mock"`, no `error`, no `net.error` event. Assert on `status`.
- A request no rule matched, under the default `fail` policy, gets status `599` and a `net.error` of kind
  `unmatched`. That is not a fault rule.

## Example

```json
{ "rules": [
  { "url": "**/v1/config", "fault": { "kind": "timeout", "holdMs": 8000 } },
  { "url": "**/v1/search*", "responses": [ { "fault": { "kind": "reset" } }, { "status": 200, "json": { "rows": [] } } ] },
  { "url": "**/v1/home*", "fault": { "kind": "status", "status": 503 }, "delayMs": 500 }
] }
```

The same faults from a spec file:

```brightscript
BTNet_fault({ url: "https://api.example.test/v1/config", kind: "timeout", holdMs: 8000 })
BTNet_fault({ url: "https://api.example.test/v1/home*", kind: "status", status: 503 })
```

For the `timeout` rule to end the app's request on device, the app under test needs `SetMinimumTransferRate` or its
own timer, as described above.

## Not verified on device

- Codes for `status` faults with a body the app did not ask to retain, and for a `timeout` fault with `partialBytes`
  set to `0`. The device run measured a 500/404 with `RetainBodyOnError(true)` and a stall with a partial body.
- Headless engine response codes for `reset` and `timeout`.
- Every fault kind end to end through the hub on hardware (TP-NET-27).
