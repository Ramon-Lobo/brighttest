sub init()
    m.store = CreateObject("roChannelStore")
    m.port = CreateObject("roMessagePort")
    m.store.SetMessagePort(m.port)
end sub

function hasEntitlement(code as string) as boolean
    m.store.GetPurchases()
    msg = wait(2000, m.port)
    if type(msg) <> "roChannelStoreEvent" then return false
    for each purchase in msg.GetResponse()
        if purchase.code = code then return true
    end for
    return false
end function
