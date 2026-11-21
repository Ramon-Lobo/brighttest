sub init()
    m.kb = m.top.findNode("searchKeyboard")
    m.kb.observeField("text", "onType")
    m.go = m.top.findNode("runSearch")
    m.go.observeField("buttonSelected", "onGo")
end sub

' Focus hand-off between the keyboard and the Go button. onKeyEvent runs on this
' screen only for keys the focused child did not consume, so Down from the
' keyboard's bottom row and Up from the button reach here when the key falls through.
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "down" and m.kb.isInFocusChain() and not m.go.hasFocus() then
        m.go.setFocus(true)
        return true
    else if key = "up" and m.go.hasFocus() then
        m.kb.setFocus(true)
        return true
    end if
    return false
end function

sub onFocusEnter()
    if m.top.focusEnter then m.kb.setFocus(true)
end sub

sub onType()
    m.top.findNode("searchQuery").text = "Query: " + m.kb.text
end sub

sub onGo()
    m.top.action = { id: "runSearch", query: m.kb.text }
end sub

sub onError()
    m.top.findNode("searchError").text = m.top.errorText
end sub
