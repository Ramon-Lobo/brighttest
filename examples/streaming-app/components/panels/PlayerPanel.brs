sub init()
    m.video = m.top.findNode("player")
    m.stateLabel = m.top.findNode("playerState")
    m.lastReport = 0
    m.video.observeField("state", "onState")
    m.video.observeField("position", "onPosition")
end sub

sub render()
    d = m.top.data
    if d = invalid or d.item = invalid then return
    m.item = d.item

    content = CreateObject("roSGNode", "ContentNode")
    content.url = m.item.url
    content.streamFormat = m.item.streamFormat
    content.title = m.item.title
    m.video.content = content

    if d.resume <> invalid and d.resume > 0 then m.video.seek = d.resume
    m.video.control = "play"
    ' Keep focus on the panel (not the Video) so Back reaches us instead of being swallowed by the player.
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        m.video.control = "stop"   ' stop playback, then let MainScene navigate Home
    end if
    return false
end function

sub onState()
    m.stateLabel.text = "state: " + m.video.state
    reportProgress(Int(m.video.position))
end sub

' Throttle progress persistence to ~every 10s (and on any backward jump / seek).
sub onPosition()
    p = m.video.position
    if p - m.lastReport >= 10 or p < m.lastReport
        m.lastReport = p
        reportProgress(Int(p))
    end if
end sub

sub reportProgress(positionSec as integer)
    if m.item = invalid then return
    m.top.progress = m.item.id + "|" + StrI(positionSec).Trim() + "|" + StrI(m.item.length).Trim()
end sub
