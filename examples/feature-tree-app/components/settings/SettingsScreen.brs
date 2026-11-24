sub init()
    m.section = CreateObject("roRegistrySection", "settings")
    m.top.findNode("settingsTitle").text = m.section.Read("profile")
end sub

sub refresh()
    m.section.Write("profile", "default")
    m.section.Flush()
end sub
