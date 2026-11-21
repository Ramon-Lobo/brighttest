sub init()
    m.label = m.top.findNode("badgeLabel")
    ' Not supported by every engine (non-device behaviour): exercised by the bt-nondevice suite.
    m.label.forceUpperCase = true
end sub

sub onText()
    m.label.text = m.top.text
end sub
