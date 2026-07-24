sub init()
    m.play = m.top.findNode("playButton")
    m.play.observeField("buttonSelected", "onPlay")
end sub

sub render()
    d = m.top.data
    if d = invalid or d.item = invalid then return
    m.item = d.item
    m.top.findNode("poster").uri = m.item.poster
    m.top.findNode("detailsTitle").text = m.item.title
    m.top.findNode("detailsMeta").text = UCase(m.item.streamFormat) + "  ·  " + m.item.lengthText
    m.top.findNode("detailsDesc").text = m.item.description
    if d.resume <> invalid and d.resume > 0
        m.play.text = "Resume"
    else
        m.play.text = "Play"
    end if
end sub

sub onFocusEnter()
    if m.top.focusEnter then m.play.setFocus(true)
end sub

sub onPlay()
    if m.item <> invalid then m.top.action = "play:" + m.item.id
end sub
