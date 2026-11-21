sub init()
    m.grid = m.top.findNode("catalogGrid")
    root = CreateObject("roSGNode", "ContentNode")
    for each it in BTDev_catalog()
        c = root.createChild("ContentNode")
        c.id = it.id
        c.title = it.title
    end for
    m.grid.content = root
    m.grid.observeField("itemSelected", "onSelect")
end sub

sub focusDefault()
    m.grid.setFocus(true)
end sub

sub onSelect(event as object)
    m.global.selectedId = m.grid.content.getChild(event.getData()).id
    m.top.action = "open:DetailsPanel"
end sub
