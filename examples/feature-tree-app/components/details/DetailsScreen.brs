sub init()
    m.player = m.top.findNode("player")
end sub

sub refresh()
    m.top.findNode("heading").text = Config_resumeKey(m.top.contentId)
end sub

sub play()
    m.player.callFunc("refresh")
end sub
