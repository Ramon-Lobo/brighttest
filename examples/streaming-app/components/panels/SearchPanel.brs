sub init()
    m.kbd = m.top.findNode("kbd")
    m.status = m.top.findNode("searchStatus")
    m.results = m.top.findNode("results")
    m.items = []
    ' The Keyboard node accumulates remote text (incl. ECP Lit_ keypresses) into its `text` field.
    m.kbd.observeField("text", "onQuery")
end sub

sub onFocusEnter()
    if m.top.focusEnter then m.kbd.setFocus(true)
end sub

sub buildUI()
    d = m.top.data
    if d = invalid or d.items = invalid then return
    m.items = d.items
    renderResults(m.items)
    m.status.text = "Type to search " + StrI(m.items.count()).Trim() + " titles"
end sub

sub onQuery()
    q = m.kbd.text
    matches = Search_filter(m.items, q)
    renderResults(matches)
    if q.Trim() = ""
        m.status.text = "Type to search " + StrI(m.items.count()).Trim() + " titles"
    else
        m.status.text = StrI(matches.count()).Trim() + " result(s) for " + Chr(34) + q + Chr(34)
    end if
end sub

' Render matching titles as posters with id "result-<id>" so e2e can assertVisible/assertGone them.
sub renderResults(items as object)
    while m.results.getChildCount() > 0
        m.results.removeChildIndex(0)
    end while
    x = 0
    for each item in items
        m.results.appendChild(makeTile(item, x))
        x = x + 210
    end for
end sub

function makeTile(item as object, x as integer) as object
    g = CreateObject("roSGNode", "Group")
    g.id = "result-" + item.id
    g.translation = [x, 0]

    if item.poster <> ""
        p = CreateObject("roSGNode", "Poster")
        p.width = 180 : p.height = 260 : p.loadDisplayMode = "scaleToFit" : p.uri = item.poster
        g.appendChild(p)
    else
        card = CreateObject("roSGNode", "Rectangle")
        card.width = 180 : card.height = 260 : card.color = "0x1B2030FF"
        g.appendChild(card)
    end if

    t = CreateObject("roSGNode", "Label")
    t.width = 180 : t.translation = [0, 266] : t.text = item.title : t.color = "0xE7EAF3FF" : t.wrap = true
    g.appendChild(t)
    return g
end function
