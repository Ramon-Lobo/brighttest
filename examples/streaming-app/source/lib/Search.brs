' Case-insensitive title filter. Pure — unit-tested headless.
function Search_filter(items as object, query as string) as object
    q = LCase(query.Trim())
    if q = "" then return items
    out = []
    for each it in items
        if Instr(1, LCase(it.title), q) > 0 then out.push(it)
    end for
    return out
end function
