sub init()
    m.ids = ["searchButton", "signInButton", "focusDemoButton", "tile1", "tile2", "tile3"]
    for each id in m.ids
        m.top.findNode(id).observeField("buttonSelected", "onSelect")
    end for
    m.index = 3
end sub

sub onFocusEnter()
    if m.top.focusEnter then m.top.findNode(m.ids[m.index]).setFocus(true)
end sub

sub onHero()
    m.top.findNode("heroTitle").text = m.top.heroTitle
end sub

sub onTier()
    m.top.findNode("tierLabel").text = m.top.tierText
end sub

sub onSelect(msg as object)
    m.top.action = { id: msg.getRoSGNode().id }
end sub

' Two rows: nav (first three) above tiles (last three).
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    row = m.index \ 3
    col = m.index mod 3
    if key = "right" and col < 2
        m.index = m.index + 1
    else if key = "left" and col > 0
        m.index = m.index - 1
    else if key = "down" and row = 0
        m.index = m.index + 3
    else if key = "up" and row = 1
        m.index = m.index - 3
    else
        return false
    end if
    m.top.findNode(m.ids[m.index]).setFocus(true)
    return true
end function
