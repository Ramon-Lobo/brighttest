sub onItem()
    m.top.findNode("detailsTitle").text = Format_titleCase("details for " + m.top.itemId)
end sub

sub onTracking()
    m.top.findNode("trackingStatus").text = m.top.trackingStatus
end sub
