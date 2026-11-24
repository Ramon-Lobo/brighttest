sub Log_info(msg as string)
    line = Str_trim(msg)
    #if DEBUG
        print "[info] "; line
    #end if
    if m.global <> invalid and m.global.analyticsCount <> invalid
        m.global.analyticsCount = m.global.analyticsCount + 1
    end if
end sub
