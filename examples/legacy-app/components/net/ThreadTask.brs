sub init()
    m.top.functionName = "record"
end sub

' Runs via functionName, i.e. on the task thread; also reads m.global from the task.
sub record()
    m.top.globalKeys = Util_countKeys(m.global.config)
    m.top.ranOn = "task"
end sub
