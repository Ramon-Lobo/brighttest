' Observer for the opt-in /input order probe. Lives on a plain Node (not the Scene) so a spec can target it
' without a Scene host. Adds the global fields only when enabled, so default snapshots are unchanged.
sub onEnable()
    if not m.top.enabled or m.probeOn = true then return
    m.probeOn = true
    ' alwaysNotify on inputProbe so a repeated identical value still fires the observer.
    m.global.addField("inputProbe", "string", true)
    m.global.addField("inputProbeLog", "string", false)
    m.global.observeField("inputProbe", "onInputProbe")
end sub

' Append the event's own value (not a field re-read) so coalesced writes cannot hide ordering.
sub onInputProbe(msg as object)
    id = msg.getData()
    if type(id) <> "roString" and type(id) <> "String" then return
    if id = "" then return
    m.global.inputProbeLog = InputProbe_append(m.global.inputProbeLog, id, 1800)
end sub
