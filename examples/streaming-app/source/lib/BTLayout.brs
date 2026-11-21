' Publishes grid layout fields for the brighttest studio overlay.
'
' Roku's ECP dumps a SceneGraph tree, but omits every ArrayGrid layout field (itemSize, itemSpacing,
' numColumns, ...) AND the offsets of the item components a grid lays out internally — so the studio can
' only ESTIMATE where grid items sit (from the run of items the grid has realized). An app that calls
' this makes those positions exact: it mirrors each grid's layout fields as JSON into a hidden Label with
' the well-known id "__bt_layout" (the same mechanism as BTState_publish), and the studio combines them
' with the rendered run to compute true item rects.
'
' Call it once after your grids exist (and again if a grid's layout fields change at runtime):
'
'     BTLayout_publish(m.top.getScene(), ["homeRows", "searchResults"])
'
' Grids are looked up by node id. Rows created from a shared template share an id — that is fine (they
' share a layout too); every grid with a matching id gets the same hint.
sub BTLayout_publish(parent as object, gridIds as object)
    if parent = invalid or gridIds = invalid then return
    layout = {}
    fields = ["itemSize", "itemSpacing", "numColumns", "numRows", "rowHeights", "rowItemSize", "itemSpacings"]
    for each id in gridIds
        g = parent.findNode(id)
        if g <> invalid
            entry = {}
            for each f in fields
                if g.hasField(f) and g[f] <> invalid
                    entry[f] = g[f]
                end if
            end for
            if entry.count() > 0 then layout[id] = entry
        end if
    end for

    node = parent.findNode("__bt_layout")
    if node = invalid
        node = parent.createChild("Label")
        node.id = "__bt_layout"
        node.visible = false   ' inspection-only; never drawn
    end if
    json = FormatJson(layout)
    if json = invalid then json = "{}"
    node.text = json
end sub
