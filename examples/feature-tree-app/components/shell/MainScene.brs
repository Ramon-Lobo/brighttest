sub init()
    m.global.addFields({ analyticsCount: 0 })
    m.api = CreateObject("roSGNode", "ApiTask")
    m.api.observeField("content", "onContent")
    m.api.control = "RUN"
    m.home = m.top.findNode("home")
    m.home.observeField("selected", "onSelected")
    m.tick = m.top.findNode("tick")
    m.tick.observeField("fire", "onTick")
    m.tick.control = "start" : m.home.setFocus(true)
end sub

sub onContent()
    Log_info("content ready")
end sub

sub onSelected()
    kind = "DetailsScreen"
    if m.home.selected = "settings" then kind = "SettingsScreen"
    m.top.appendChild(CreateObject("roSGNode", kind))
end sub

sub onTick()
    m.global.analyticsCount = m.global.analyticsCount + 1
end sub
