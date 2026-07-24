sub init()
    m.stage = m.top.findNode("stage")
    m.current = ""
    m.reg = CreateObject("roRegistrySection", "openCinema")

    text = ReadAsciiFile("pkg:/data/feed.json")
    m.feed = Feed_parse(text)
    for each it in m.feed.items
        it.lengthText = Format_duration(it.length)
    end for

    showPanel("HomePanel", "")
end sub

' Mount one panel at a time in the stage, handing it the data it needs via its `data` field.
sub showPanel(name as string, contentId as string)
    ' Stop any playing video before tearing down the current panel (removal alone doesn't stop playback).
    v = m.stage.findNode("player")
    if v <> invalid then v.control = "stop"
    while m.stage.getChildCount() > 0
        m.stage.removeChildIndex(0)
    end while
    panel = CreateObject("roSGNode", name)
    panel.observeField("action", "onAction")
    panel.observeField("progress", "onProgress")
    m.stage.appendChild(panel)
    ' Set data AFTER the panel is in the tree so render (which starts playback) runs while mounted.
    if name = "HomePanel"
        panel.data = { categories: m.feed.categories, continueWatching: continueItems() }
    else if name = "DetailsPanel" or name = "PlayerPanel"
        panel.data = { item: Feed_findById(m.feed, contentId), resume: watchPosition(contentId) }
    else if name = "SearchPanel"
        panel.data = { items: m.feed.items }
    end if
    panel.setFocus(true)
    panel.focusEnter = true
    m.current = name
end sub

' verb:id actions from panels → navigation.
sub onAction(msg as object)
    a = msg.getData()
    if a = "" then return
    i = Instr(1, a, ":")
    verb = a
    id = ""
    if i > 0
        verb = Left(a, i - 1)
        id = Mid(a, i + 1)
    end if
    if verb = "search" then showPanel("SearchPanel", "")
    if verb = "open" then showPanel("DetailsPanel", id)
    if verb = "play" then showPanel("PlayerPanel", id)
end sub

' The player reports playback progress as "id|position|length"; persist it for continue-watching.
sub onProgress(msg as object)
    parts = progressParts(msg.getData())
    if parts.id = "" then return
    list = loadWatchlist()
    list = Watchlist_upsert(list, parts.id, parts.position, parts.length, 0)
    m.reg.Write("watchlist", FormatJson(list))
    m.reg.Flush()
end sub

function progressParts(s as string) as object
    out = { id: "", position: 0, length: 0 }
    a = Instr(1, s, "|")
    if a <= 0 then return out
    out.id = Left(s, a - 1)
    rest = Mid(s, a + 1)
    b = Instr(1, rest, "|")
    if b <= 0 then return out
    out.position = Int(Val(Left(rest, b - 1)))
    out.length = Int(Val(Mid(rest, b + 1)))
    return out
end function

function loadWatchlist() as object
    raw = m.reg.Read("watchlist")
    if raw = invalid or raw = "" then return []
    parsed = ParseJson(raw)
    if parsed = invalid then return []
    return parsed
end function

function watchPosition(id as string) as integer
    return Watchlist_position(loadWatchlist(), id)
end function

' Continue-watching items resolved against the feed (most recent first).
function continueItems() as object
    out = []
    for each e in loadWatchlist()
        it = Feed_findById(m.feed, e.id)
        if it <> invalid then out.push(it)
    end for
    return out
end function

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        ' Back always returns to Home (deterministic for e2e); never exits the channel.
        if m.current <> "HomePanel" then showPanel("HomePanel", "") : return true
    end if
    return false
end function
