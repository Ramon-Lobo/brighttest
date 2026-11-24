sub init()
    m.video = m.top.findNode("video")
end sub

sub seek()
    m.video.seek = Resume_clamp(m.video.position, m.video.duration)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if press and key = "right"
        seek()
        return true
    end if
    return false
end function
