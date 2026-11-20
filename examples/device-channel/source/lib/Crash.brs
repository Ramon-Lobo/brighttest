' Deliberate runtime error for crash-probe cases (ROB-02b/13/15/29). The marker is printed first so a
' log assertion can see it; the failing statement is the line below ("Invalid", member call on invalid).
sub BTDev_crash(kind as string)
    BTDev_log("crash", "kind=" + kind)
    target = m.doesNotExist
    target.boom()
end sub
