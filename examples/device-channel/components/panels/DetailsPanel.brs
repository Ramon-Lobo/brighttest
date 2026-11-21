sub init()
    it = BTDev_findItem(m.global.selectedId)
    if it = invalid then it = BTDev_catalog()[0]
    m.top.findNode("detailsTitle").text = it.title
    m.top.findNode("detailsMeta").text = BTDev_formatDuration(it.durationSec)
    m.top.findNode("detailsBody").text = it.desc
    m.play = m.top.findNode("playButton")
    m.play.observeField("buttonSelected", "onPlay")
end sub

sub focusDefault()
    m.play.setFocus(true)
end sub

sub onPlay()
    m.top.action = "open:PlayerPanel"
end sub
