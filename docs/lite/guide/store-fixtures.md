# roChannelStore fixtures

::: info At a glance
**What it is for:** testing purchase flows headless: the engine answers `roChannelStore` from XML in your package.

**You will:**
- Turn on the fake server
- Add `csfake/*.xml` fixtures
- Run `examples/store-fixtures-app/`

**First command:** `cd examples/store-fixtures-app && brighttest`
:::

::: warning Headless only, not device-verified
Runs on `brs-node` only; a real device ignores `csfake/*.xml`. A pass checks app logic, not the real store.
:::

## What the engine supports

`roChannelStore` is **Partial** (row 21, 2026-11-19 RSG coverage research, in the project planning notes):

- `ifGetMessagePort` / `ifSetMessagePort` are not exposed through `GetInterface`.
- Catalog and purchase data come only from `csfake/*.xml`, only with `fakeServer` on.
- The credential store is simulated.
- Without `fakeServer(true)`, only `GetRokuCustomerId` works (row 19, `ChannelStore`).

Row 24 treats purchase-flow testing as a docs and example task, since the engine reads the fixtures. No device cross-check is claimed.

## Enable it

```brightscript
store = CreateObject("roChannelStore")
store.SetMessagePort(CreateObject("roMessagePort"))
store.FakeServer(true)      ' without this the fixtures are ignored
```

## Where the XML goes

Put a `csfake/` folder at the project root (`pkg:/csfake/<Name>.xml`) and include it in `sourceGlobs`. Names are fixed by the engine's 2.2.0 bundle and may change later:

| File | Used by | Shape |
|---|---|---|
| `GetCatalog.xml` | `GetCatalog`, `GetStoreCatalog`, product check in `DoOrder` | `<result><products><product>` with `code`, `name`, `cost`, `productType`, `qty` |
| `GetPurchases.xml` | `GetPurchases`, `GetAllPurchases` | same `<products><product>` shape |
| `CheckOrder.xml` | `DoOrder` | `<result><order><id>` |
| `PlaceOrder.xml` | `DoOrder` | `<result><order><id>` plus `<items><orderItem>` |

Results arrive as `roChannelStoreEvent` messages on your port:

- Ordered `code` missing from `GetCatalog.xml` or without positive `qty`: code `-3` ("Invalid Product Order").
- `<id>` in `PlaceOrder.xml` differs from `CheckOrder.xml`: "Order Mismatch".
- Missing or unparsable file: empty response, not an app error.

## `pkg:/` in the headless run

The default lane mounts the staged build as package root, so include `csfake/**/*` in `sourceGlobs` and `pkg:/csfake/...` resolves.

- Same with a `deviceInfo` block (which also passes the root to the engine API) and on the network-fixture lane.
- `instrument.net` is not needed.
- The `@SGNode` scene-runner path (coverage-headless) mounts its own root, unchanged.

### Behaviour change (default and `deviceInfo` lanes)

- The staged `manifest` is read: `bs_const` is honoured, `roAppInfo` `GetTitle` / `GetVersion` return your values, `pkg:/manifest` is readable.
- `splash_min_time` is forced to `0` in the staged copy only, so headless runs are never slowed. Your `manifest` is untouched.

## Example spec

```brightscript
@it("completes a purchase of a catalogue product")
function _()
  s = Store_open(true)
  m.assertTrue(Store_buy(s, "gold-monthly"))
end function
```

`cd examples/store-fixtures-app && brighttest` passes three specs: catalogue listed, purchase succeeds, unknown product rejected.

## Limits

- Static data: every run gets the same catalogue and order. Switch fixtures per suite for failure paths, not at runtime (`pkg:/` is read-only).
- Receipts, dunning, region data and attestation are not modelled.
- No device claim: the flow was not checked on a device.

## Related

- [Network fixtures](/writing-tests/http-fixtures): HTTP fixtures

**Full guide:** [roChannelStore fixtures](full:/guide/store-fixtures) — the original wording.
