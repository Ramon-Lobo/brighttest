sub init()
    m.kb = m.top.findNode("searchKeyboard")
    m.kb.observeField("text", "onType")
    m.top.findNode("runSearch").observeField("buttonSelected", "onGo")
end sub

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
