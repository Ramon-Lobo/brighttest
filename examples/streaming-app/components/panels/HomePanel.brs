sub init()
    m.rows = m.top.findNode("rows")
    m.searchBtn = m.top.findNode("searchButton")
    m.searchRing = m.top.findNode("searchRing")
    m.grid = []   ' 2D array of tile Groups
    m.rings = []  ' parallel 2D array of highlight Rectangles
    m.ids = []    ' parallel 2D array of content ids
    m.row = 0
    m.col = 0
    m.onSearch = false   ' true when the Search button (not the grid) holds focus
end sub

sub onFocusEnter()
    if m.top.focusEnter and m.grid.count() > 0 then focusCell()
end sub

' Build the content rows from the feed data handed in via `data`.
sub buildRows()
    while m.rows.getChildCount() > 0
        m.rows.removeChildIndex(0)
    end while
    m.grid = [] : m.rings = [] : m.ids = []
    data = m.top.data
    if data = invalid then return

    y = 0
    if data.continueWatching <> invalid and data.continueWatching.count() > 0
        addRow("Continue Watching", data.continueWatching, y)
        y = y + 420
    end if
    for each cat in data.categories
        addRow(cat.title, cat.items, y)
        y = y + 420
    end for
    focusCell()
end sub

sub addRow(title as string, items as object, rowTop as integer)
    lbl = m.rows.createChild("Label")
    lbl.text = title
    lbl.translation = [80, rowTop]
    lbl.color = "0x8A90A6FF"

    gridRow = [] : ringRow = [] : idRow = []
    x = 80
    for each item in items
        tile = makeTile(item, x, rowTop + 44)
        m.rows.appendChild(tile.group)
        gridRow.push(tile.group) : ringRow.push(tile.ring) : idRow.push(item.id)
        x = x + 210
    end for
    m.grid.push(gridRow) : m.rings.push(ringRow) : m.ids.push(idRow)
end sub

function makeTile(item as object, x as integer, y as integer) as object
    g = CreateObject("roSGNode", "Group")
    g.id = "tile-" + item.id
    g.translation = [x, y]

    ring = CreateObject("roSGNode", "Rectangle")
    ring.width = 192 : ring.height = 272 : ring.translation = [-6, -6]
    ring.color = "0x7C6CFFFF" : ring.visible = false
    g.appendChild(ring)

    if item.poster <> ""
        p = CreateObject("roSGNode", "Poster")
        p.width = 180 : p.height = 260 : p.loadDisplayMode = "scaleToFit" : p.uri = item.poster
        g.appendChild(p)
    else
        card = CreateObject("roSGNode", "Rectangle")
        card.width = 180 : card.height = 260 : card.color = "0x1B2030FF"
        g.appendChild(card)
    end if

    t = CreateObject("roSGNode", "Label")
    t.width = 180 : t.translation = [0, 266] : t.text = item.title : t.color = "0xE7EAF3FF" : t.wrap = true
    g.appendChild(t)
    return { group: g, ring: ring }
end function

sub focusCell()
    if m.grid.count() = 0 then return
    if m.onSearch
        for each ringRow in m.rings
            for each r in ringRow
                r.visible = false
            end for
        end for
        m.searchRing.visible = true
        m.searchBtn.setFocus(true)
        return
    end if
    m.searchRing.visible = false
    m.row = clamp(m.row, m.grid.count())
    m.col = clamp(m.col, m.grid[m.row].count())
    for each ringRow in m.rings
        for each r in ringRow
            r.visible = false
        end for
    end for
    m.rings[m.row][m.col].visible = true
    ' Give the focused tile real SceneGraph focus so it shows as focused in sgnodes — this is what lets
    ' e2e `focus:` navigate to a tile, and keeps key events bubbling up to this panel.
    m.grid[m.row][m.col].setFocus(true)
    ' keep the focused row on screen
    m.rows.translation = [0, 140 - firstVisibleOffset()]
end sub

function firstVisibleOffset() as integer
    top = m.row * 420
    if top < 840 then return 0
    return top - 420
end function

function clamp(index as integer, length as integer) as integer
    if length <= 0 then return 0
    if index < 0 then return 0
    if index >= length then return length - 1
    return index
end function

function onKeyEvent(key as string, press as boolean) as boolean
    if not press or m.grid.count() = 0 then return false
    if m.onSearch
        if key = "down"
            m.onSearch = false
            focusCell()
            return true
        else if key = "OK"
            m.top.action = "search:"
            return true
        end if
        return true   ' swallow left/right/up while on the Search button
    end if
    if key = "up"
        if m.row = 0
            m.onSearch = true
            focusCell()
            return true
        end if
        m.row = clamp(m.row - 1, m.grid.count())
        m.col = clamp(m.col, m.grid[m.row].count())
        focusCell()
        return true
    else if key = "down"
        m.row = clamp(m.row + 1, m.grid.count())
        m.col = clamp(m.col, m.grid[m.row].count())
        focusCell()
        return true
    else if key = "left" or key = "right"
        delta = -1
        if key = "right" then delta = 1
        m.col = clamp(m.col + delta, m.grid[m.row].count())
        focusCell()
        return true
    else if key = "OK"
        m.top.action = "open:" + m.ids[m.row][m.col]
        return true
    end if
    return false
end function
