# store-fixtures-app (COV-24)

A tiny generic example of an `roChannelStore` purchase flow tested headless against the engine's `fakeServer`
fixtures. Invented product names only. See `docs/guide/store-fixtures.md` for the guide.

- `source/Store.brs`: opens the store, reads the catalogue, places one order.
- `csfake/GetCatalog.xml`, `csfake/CheckOrder.xml`, `csfake/PlaceOrder.xml`: the fixtures the engine reads.
- `source/tests/Store.spec.bs`: lists the catalogue, buys `gold-monthly`, rejects an unknown product.
- `brighttest.json` sets `"instrument": { "net": true }`; see the guide for why.

```
cd examples/store-fixtures-app
brighttest
```

Headless only. This example has not been checked on a device.
