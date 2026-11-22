# roChannelStore fixtures

Test purchase flows without a store: the headless engine can answer `roChannelStore` from XML files in your
package when you turn on its fake server. This page shows how to enable it, where the XML goes and what the
engine does not provide. The runnable sample is `examples/store-fixtures-app/`.

::: warning Headless only, not device-verified
The sample runs on the headless engine (`brs-node`). It has not been run on a Roku device, and a real device
does not read `csfake/*.xml`. Treat a passing run as a check of your app logic, not of the real store.
:::

## What the engine supports

The coverage research marks `roChannelStore` as **Partial** (row 21 of the 2026-11-19 RSG coverage research, kept with the
project planning notes):

- The interfaces `ifGetMessagePort` and `ifSetMessagePort` are not exposed through `GetInterface`.
- Catalog and purchase data come only from `csfake/*.xml`, and only when `fakeServer` is enabled.
- The credential store is simulated.
- Without `fakeServer(true)`, only `GetRokuCustomerId` works (research row 19, `ChannelStore`).

The research (row 24) treats purchase flows under test as a docs and example task, because the engine already
reads the fixtures. It does not claim a device cross-check.

## Enable it

```brightscript
store = CreateObject("roChannelStore")
store.SetMessagePort(CreateObject("roMessagePort"))
store.FakeServer(true)      ' without this the fixtures are ignored
```

## Where the XML goes

Fixtures live at `pkg:/csfake/<Name>.xml`, so put them in a `csfake/` folder at the project root and include it
in `sourceGlobs`. The names are fixed by the engine (read from its 2.2.0 bundle; they may change in later engines):

| File | Used by | Shape |
|---|---|---|
| `GetCatalog.xml` | `GetCatalog`, `GetStoreCatalog`, and the product check in `DoOrder` | `<result><products><product>` with `code`, `name`, `cost`, `productType`, `qty` |
| `GetPurchases.xml` | `GetPurchases`, `GetAllPurchases` | same `<products><product>` shape |
| `CheckOrder.xml` | `DoOrder` | `<result><order><id>` |
| `PlaceOrder.xml` | `DoOrder` | `<result><order><id>` plus `<items><orderItem>` entries |

How a purchase resolves: each ordered `code` must exist in `GetCatalog.xml` with a positive `qty`, otherwise the
event reports code `-3` ("Invalid Product Order"). The `<id>` in `PlaceOrder.xml` must equal the one in
`CheckOrder.xml`, otherwise "Order Mismatch". Results arrive as `roChannelStoreEvent` messages on your port. A
missing or unparsable file gives an empty response, not an error in your app.

## Make `pkg:/` visible to the headless run

The default headless lane starts the engine without a package root, so `pkg:/csfake/...` does not exist and every
catalogue comes back empty (the sample's first run failed this way). The lane that does mount the staged build as
the package root is the one used for network fixtures. Turning it on is enough:

```json
{
  "sourceGlobs": ["manifest", "csfake/**/*", "source/**/*"],
  "instrument": { "net": true }
}
```

This starts the instrument hub for the run even if your specs make no HTTP calls. It is a workaround, not a
documented feature of the store support; if the default lane later mounts the package root, you can drop it.

## Example spec

```brightscript
@it("completes a purchase of a catalogue product")
function _()
  s = Store_open(true)
  m.assertTrue(Store_buy(s, "gold-monthly"))
end function
```

Run it with `cd examples/store-fixtures-app && brighttest`: three specs pass (catalogue listed, purchase succeeds,
unknown product rejected).

## Limits

- The data is static: every run sees the same catalogue and the same order result. Test failure paths by
  switching fixtures per suite, not at runtime (`pkg:/` is read-only in the engine).
- Real store behaviours (receipts, dunning, region data, attestation) are not modelled.
- No device claim: a device check of the same flow has not been done.
