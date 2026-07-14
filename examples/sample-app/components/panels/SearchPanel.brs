sub init()
    m.kb = m.top.findNode("searchKeyboard")
    m.query = m.top.findNode("searchQuery")
    m.kb.observeField("text", "onType")
end sub

sub onFocusEnter()
    if m.top.focusEnter then m.kb.setFocus(true)
end sub

sub onType()
    m.query.text = "Query: " + m.kb.text
end sub
