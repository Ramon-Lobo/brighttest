' 8085 marker helpers. One marker per line: BTDEV:<event> <detail>
sub BTDev_log(event as string, detail = "" as string)
    if detail = "" then print "BTDEV:" + event else print "BTDEV:" + event + " " + detail
end sub

sub BTDev_logArgs(args as dynamic)
    if type(args) <> "roAssociativeArray"
        BTDev_log("args", "none")
        return
    end if
    keys = args.keys()
    keys.sort()
    for each k in keys
        BTDev_log("args", k + "=" + BTDev_str(args[k]))
    end for
    if keys.count() = 0 then BTDev_log("args", "none")
end sub

function BTDev_str(v as dynamic) as string
    if type(v) = "roString" or type(v) = "String" then return v
    if type(v) = "roInt" or type(v) = "Integer" or type(v) = "roFloat" or type(v) = "Float" then return Str(v).trim()
    if type(v) = "roBoolean" or type(v) = "Boolean" then
        if v then return "true"
        return "false"
    end if
    return "<" + type(v) + ">"
end function
