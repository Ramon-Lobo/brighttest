sub init()
  if not m.global.hasField("initLog") then m.global.addFields({ initLog: "" })
  m.global.initLog = m.global.initLog + "scene-init;"
end sub
function runAll(port)
  return "runAll-ok"
end function
