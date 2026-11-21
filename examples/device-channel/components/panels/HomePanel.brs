sub init()
    m.menu = m.top.findNode("menuList")
    m.rows = m.top.findNode("homeRows")
    m.panels = ["GridPanel", "SettingsPanel", "DialogsPanel", "PlayerPanel", "NetPanel", "TasksPanel", "PerfPanel", "ProbePanel"]
    labels = ["Catalog grid", "Settings", "Dialogs", "Player", "Network", "Tasks", "Performance", "Probes"]
    menu = CreateObject("roSGNode", "ContentNode")
    for each l in labels
        menu.createChild("ContentNode").title = l
    end for
    m.menu.content = menu
    m.menu.observeField("itemSelected", "onMenu")

    root = CreateObject("roSGNode", "ContentNode")
    items = BTDev_catalog()
    for r = 0 to 1
        row = root.createChild("ContentNode")
        row.title = "Row " + (r + 1).toStr()
        for each it in items
            if it.row = r
                c = row.createChild("ContentNode")
                c.id = it.id
                c.title = it.title
            end if
        end for
    end for
    m.rows.content = root
    m.rows.observeField("rowItemSelected", "onTile")
end sub

sub focusDefault()
    m.menu.setFocus(true)
end sub

sub onMenu(event as object)
    m.top.action = "open:" + m.panels[event.getData()]
end sub

sub onTile(event as object)
    sel = event.getData()
    row = m.rows.content.getChild(sel[0])
    m.global.selectedId = row.getChild(sel[1]).id
    m.top.action = "open:DetailsPanel"
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "right" and m.menu.isInFocusChain() and not m.rows.isInFocusChain()
        m.rows.setFocus(true)
        return true
    else if key = "left" and m.rows.isInFocusChain()
        m.menu.setFocus(true)
        return true
    end if
    return false
end function
