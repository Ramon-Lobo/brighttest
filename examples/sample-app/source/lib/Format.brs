' Small pure helpers used by the app UI and covered by unit tests (headless, no device).
' Plain BrightScript so the same file runs on the real device AND is exercised by Rooibos.

' "the wire" -> "The Wire"
function Format_titleCase(text as string) as string
    result = ""
    capNext = true
    for each ch in text.split("")
        if ch = " "
            capNext = true
            result = result + ch
        else if capNext
            result = result + ucase(ch)
            capNext = false
        else
            result = result + lcase(ch)
        end if
    end for
    return result
end function

function Format_pad2(n as integer) as string
    if n < 10 then return "0" + n.toStr()
    return n.toStr()
end function

' 3661 -> "1:01:01", 61 -> "1:01"
function Format_duration(totalSeconds as integer) as string
    if totalSeconds < 0 then totalSeconds = 0
    h = totalSeconds \ 3600
    m = (totalSeconds mod 3600) \ 60
    s = totalSeconds mod 60
    if h > 0 then return h.toStr() + ":" + Format_pad2(m) + ":" + Format_pad2(s)
    return m.toStr() + ":" + Format_pad2(s)
end function

' Wrap an index into [0, len) so D-pad navigation never runs off the ends (clamps, doesn't wrap).
function Format_clampIndex(index as integer, length as integer) as integer
    if length <= 0 then return 0
    if index < 0 then return 0
    if index >= length then return length - 1
    return index
end function
