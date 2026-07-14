sub init()
    m.grid = [
        [m.top.findNode("searchButton"), m.top.findNode("settingsButton")],
        [m.top.findNode("tileNews"), m.top.findNode("tileSports"), m.top.findNode("tileMovies")]
    ]
    m.row = 0
    m.col = 0
    for each rowArr in m.grid
        for each btn in rowArr
            btn.observeField("buttonSelected", "onSelected")
        end for
    end for
end sub

sub onFocusEnter()
    if m.top.focusEnter then focusCell()
end sub

sub focusCell()
    m.grid[m.row][m.col].setFocus(true)
end sub

sub onSelected()
    ' Report which control was activated; HomeScene observes `action` and navigates.
    m.top.action = m.grid[m.row][m.col].id
end sub

' Clamp an index into [0, length) — kept local to the component. (Render-thread component scripts don't
' see pkg:/source globals; the identical logic lives in source/lib/Format.brs for the unit tests.)
function clamp(index as integer, length as integer) as integer
    if length <= 0 then return 0
    if index < 0 then return 0
    if index >= length then return length - 1
    return index
end function

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "up" or key = "down"
        delta = -1
        if key = "down" then delta = 1
        m.row = clamp(m.row + delta, m.grid.count())
        m.col = clamp(m.col, m.grid[m.row].count())
    else if key = "left" or key = "right"
        delta = -1
        if key = "right" then delta = 1
        m.col = clamp(m.col + delta, m.grid[m.row].count())
    else
        return false
    end if
    focusCell()
    return true
end function
