' Pure URL helpers used by HttpTask (and unit-tested without a node).
function Http_join(base as string, path as string) as string
    while base.len() > 0 and right(base, 1) = "/"
        base = left(base, base.len() - 1)
    end while
    if path = "" then return base
    if left(path, 1) <> "/" then path = "/" + path
    return base + path
end function

function Http_query(params as object) as string
    parts = []
    keys = params.keys()
    keys.sort()
    xfer = CreateObject("roUrlTransfer")
    for each k in keys
        parts.push(xfer.escape(k) + "=" + xfer.escape(params[k].toStr()))
    end for
    return parts.join("&")
end function
