' Continue-watching list logic (pure — unit-tested headless). The registry I/O that persists this list
' lives in the scene; this module only computes the next list. Entries: { id, position, length, updated }.

function Watchlist_upsert(list as object, id as string, position as integer, length as integer, nowTs as integer) as object
    out = []
    for each e in list
        if e.id <> id then out.push(e)
    end for
    out.unshift({ id: id, position: position, length: length, updated: nowTs })
    while out.count() > 10  ' keep the ten most recent
        out.pop()
    end while
    return out
end function

function Watchlist_position(list as object, id as string) as integer
    for each e in list
        if e.id = id then return e.position
    end for
    return 0
end function
