' Stub player by default (no network). With stream=<url> a real Video node plays that URL.
sub init()
    m.mode = m.top.findNode("playerMode")
    m.state = m.top.findNode("playerState")
    m.pos = m.top.findNode("playerPosition")
    m.timer = m.top.findNode("playerTimer")
    m.video = m.top.findNode("videoNode")
    m.seconds = 0
    url = m.global.streamUrl
    if url <> ""
        m.mode.text = "mode: video"
        c = CreateObject("roSGNode", "ContentNode")
        c.url = url
        c.title = "Fixture stream"
        m.video.content = c
        m.video.visible = true
        m.video.observeField("state", "onVideoState")
        m.video.control = "play"
        BTDev_log("player", "mode=video")
    else
        m.mode.text = "mode: stub"
        m.timer.observeField("fire", "onTick")
        m.timer.control = "start"
        m.state.text = "state: stub-playing"
        BTDev_log("player", "mode=stub")
    end if
end sub

sub focusDefault()
    if m.video.visible then m.video.setFocus(true)
end sub

sub onTick()
    m.seconds = m.seconds + 1
    m.pos.text = "position: " + m.seconds.toStr()
end sub

sub onVideoState(event as object)
    s = event.getData()
    m.state.text = "state: " + s
    BTDev_log("player", "state=" + s)
end sub
