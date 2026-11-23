' Vendored third-party style client: uses roUrlTransfer directly; excluded from instrumentation
' through "instrument.exclude" in brighttest.json.
function Vendor_get(url as string) as string
    x = CreateObject("roUrlTransfer")
    x.setUrl(url)
    return x.getToString()
end function
