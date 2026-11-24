function Content_parse(raw as string) as object
    items = []
    parsed = ParseJson(raw)
    if type(parsed) = "roAssociativeArray" and parsed.items <> invalid
        for each entry in parsed.items
            items.push({ id: entry.id, title: entry.title })
        end for
    end if
    return { items: items }
end function
