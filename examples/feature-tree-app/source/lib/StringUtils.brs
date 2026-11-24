function Str_trim(s as string) as string
    while left(s, 1) = " "
        s = mid(s, 2)
    end while
    while right(s, 1) = " "
        s = left(s, len(s) - 1)
    end while
    return s
end function

function Str_title(s as string) as string
    if len(s) = 0 then return s
    return ucase(left(s, 1)) + lcase(mid(s, 2))
end function
