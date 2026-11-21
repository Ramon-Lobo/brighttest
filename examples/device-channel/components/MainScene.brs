' Mounts one panel at a time. Panels talk to the scene through their "action" field:
'   open:<PanelName>  (mount a panel)   |   back (return Home)
sub init()
    m.stage = m.top.findNode("stage")
    m.current = invalid
    m.currentName = ""
    BTDev_log("scene-init", "MainScene")
    for each f in ["flag", "lastverb", "lastDialog", "counter"]
        m.global.observeField(f, "publishState")
    end for
    showPanel("HomePanel")
end sub

sub showPanel(name as string)
    if m.current <> invalid then m.stage.removeChild(m.current)
    p = CreateObject("roSGNode", name)
    p.observeField("action", "onAction")
    m.stage.appendChild(p)
    m.current = p
    m.currentName = name
    m.global.current = name
    BTDev_log("panel", name)
    m.top.setFocus(true)
    p.callFunc("focusDefault")
    publishState()
end sub

sub publishState()
    BTState_publish(m.top, { current: m.currentName, global: BTState_scalars(m.global), user: m.global.user })
end sub

sub onAction(event as object)
    a = event.getData()
    if a = "" then return
    parts = a.split(":")
    m.global.lastverb = parts[0]
    if parts[0] = "open" and parts.count() > 1 then showPanel(parts[1])
    if parts[0] = "back" then showPanel("HomePanel")
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if press then BTDev_log("key", key)
    if press and key = "back" and m.currentName <> "HomePanel"
        showPanel("HomePanel")
        return true
    end if
    return false
end function
