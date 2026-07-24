' Parse the channel feed JSON into a content model. Pure (ParseJson) — unit-tested headless.
' Returns { title, categories: [{ title, items:[item] }], items:[item] } where item is a normalized assoc.

function Feed_parse(jsonText as string) as object
    result = { title: "", categories: [], items: [] }
    data = ParseJson(jsonText)
    if data = invalid then return result
    if data.title <> invalid then result.title = data.title
    if data.categories = invalid then return result
    for each cat in data.categories
        items = []
        if cat.items <> invalid
            for each raw in cat.items
                item = Feed_normalize(raw)
                items.push(item)
                result.items.push(item)
            end for
        end if
        result.categories.push({ title: Feed_str(cat.title), items: items })
    end for
    return result
end function

function Feed_normalize(raw as object) as object
    return {
        id: Feed_str(raw.id),
        title: Feed_str(raw.title),
        description: Feed_str(raw.description),
        streamFormat: Feed_orDefault(Feed_str(raw.streamFormat), "hls"),
        url: Feed_str(raw.url),
        poster: Feed_str(raw.poster),
        length: Feed_int(raw.length)
    }
end function

function Feed_findById(model as object, id as string) as object
    for each it in model.items
        if it.id = id then return it
    end for
    return invalid
end function

function Feed_str(v as dynamic) as string
    if v = invalid then return ""
    if type(v) = "roString" or type(v) = "String" then return v
    return v.toStr()
end function

function Feed_int(v as dynamic) as integer
    if v = invalid then return 0
    return Int(v)
end function

function Feed_orDefault(v as string, fallback as string) as string
    if v = "" then return fallback
    return v
end function
