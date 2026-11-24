sub init()
    m.card = m.top.findNode("card")
    m.card.title = Str_title("featured")
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if press and key = "OK"
        m.top.selected = "details"
        return true
    end if
    return false
end function
