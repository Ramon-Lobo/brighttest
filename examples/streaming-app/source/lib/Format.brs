' Pure formatting helpers — unit-tested headless, and included by render-thread components via
' <script uri="pkg:/source/lib/Format.brs"> so the same code runs in the app and the tests.

function Format_duration(seconds as integer) as string
    if seconds < 0 then seconds = 0
    h = seconds \ 3600
    m = (seconds mod 3600) \ 60
    s = seconds mod 60
    ss = s.toStr()
    if s < 10 then ss = "0" + ss
    if h > 0
        mm = m.toStr()
        if m < 10 then mm = "0" + mm
        return h.toStr() + ":" + mm + ":" + ss
    end if
    return m.toStr() + ":" + ss
end function

' Whole-percent progress through content, clamped to [0, 100].
function Format_progress(positionSec as integer, lengthSec as integer) as integer
    if lengthSec <= 0 then return 0
    p = (positionSec * 100) \ lengthSec
    if p < 0 then return 0
    if p > 100 then return 100
    return p
end function
