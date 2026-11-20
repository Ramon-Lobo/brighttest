' Persists the one stored preference (registry section "greenfield") off the render thread.
sub init()
    m.top.functionName = "persist"
end sub

sub persist()
    section = CreateObject("roRegistrySection", "greenfield")
    section.write("lastTier", m.top.tier)
    section.flush()
    m.top.saved = true
end sub
