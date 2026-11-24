' Pure helper for the opt-in /input order probe (launch param inputprobe=1; used by TP-STA-25 step 2).
' Appends id to a comma-separated log. When the joined append would push the log past cap characters, the log is
' frozen and ends with "|full" (so a truncated log is always visible, never silently cut).
function InputProbe_append(log as string, id as string, cap as integer) as string
    if Right(log, 5) = "|full" then return log
    joined = id
    if log <> "" then joined = log + "," + id
    if Len(joined) > cap then return log + "|full"
    return joined
end function
