' Thin wrapper over roChannelStore. When fake is true the engine answers from pkg:/csfake/*.xml.
function Store_open(fake as boolean) as object
    store = CreateObject("roChannelStore")
    port = CreateObject("roMessagePort")
    store.SetMessagePort(port)
    if fake then store.FakeServer(true)
    return { store: store, port: port }
end function

' Blocks for the next roChannelStoreEvent (or invalid after timeoutMs).
function Store_nextEvent(s as object, timeoutMs = 2000 as integer) as object
    return wait(timeoutMs, s.port)
end function

function Store_catalogCodes(s as object) as object
    s.store.GetCatalog()
    event = Store_nextEvent(s)
    codes = []
    if event <> invalid and event.isRequestSucceeded()
        for each item in event.GetResponse()
            codes.push(item.code)
        end for
    end if
    return codes
end function

' Orders one unit of a product; returns true when the order succeeded.
function Store_buy(s as object, code as string) as boolean
    order = [{ code: code, qty: 1 }]
    s.store.SetOrder(order)
    if not s.store.DoOrder() then return false
    event = Store_nextEvent(s)
    return event <> invalid and event.isRequestSucceeded()
end function
