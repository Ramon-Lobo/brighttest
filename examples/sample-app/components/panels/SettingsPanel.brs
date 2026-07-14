sub init()
    m.toggle = m.top.findNode("captionsToggle")
    m.state = m.top.findNode("captionsState")
    m.on = false
    m.toggle.observeField("buttonSelected", "onToggle")
end sub

sub onFocusEnter()
    if m.top.focusEnter then m.toggle.setFocus(true)
end sub

sub onToggle()
    m.on = not m.on
    label = "Captions: off"
    if m.on then label = "Captions: on"
    m.state.text = label
end sub
