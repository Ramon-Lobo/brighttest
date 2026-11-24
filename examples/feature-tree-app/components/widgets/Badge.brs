sub init()
    m.label = m.top.findNode("badgeLabel")
end sub

sub onText()
    m.label.text = m.top.text
end sub
