function Format_titleCase(s as string) as string
    words = s.split(" ")
    out = []
    for each w in words
        if w.len() > 0
            out.push(ucase(left(w, 1)) + lcase(mid(w, 2)))
        else
            out.push(w)
        end if
    end for
    return out.join(" ")
end function

function Format_tierLabel(tier as string) as string
    return "Tier: " + tier
end function
