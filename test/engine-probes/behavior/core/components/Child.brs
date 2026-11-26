sub init()
  m.n = 0
  m.scoped = ""
  m.inited = true
  if not m.global.hasField("initLog") then m.global.addFields({ initLog: "" })
  m.global.initLog = m.global.initLog + "child-init;"
end sub
sub onObs()
  m.n = m.n + 1
end sub
function add(a, b)
  return a + b
end function
sub noret()
end sub
function echoArgs(a = "default", b = "d2")
  return a + "/" + b
end function
function echoAA(x)
  return x.a
end function
function readGlobal()
  return m.global.gA
end function
function innerText()
  return m.top.findNode("lbl").text
end function
function changeCount()
  m.top.obs = 1
  m.top.obs = 2
  return m.n
end function
function scopedObserve()
  m.top.observeFieldScoped("obs", "onScoped")
  m.top.obs = 10
  return m.top.hasField("obs")
end function
sub onScoped(ev)
  m.scoped = m.scoped + "fired;"
end sub
function scopedResult()
  return m.scoped
end function
function scopedUnobserve()
  return m.top.unobserveFieldScoped("obs")
end function
function initRan()
  return m.inited
end function

sub cbLog(ev)
  m.log = m.log + "cb;"
end sub
sub cbCnt(ev)
  m.cnt = m.cnt + 1
end sub
function obsSync()
  m.log = "before;"
  r = {}
  r.ret = m.top.observeField("obs", "cbLog")
  m.top.obs = 100
  m.log = m.log + "after;"
  r.order = m.log
  r.bad_field = m.top.observeField("nosuch", "cbLog")
  r.bad_callback = m.top.observeField("obs", "nosuchFunction")
  m.log = ""
  m.top.obs = 101
  r.nested = ""
  return r
end function
function globalObserve()
  m.log = ""
  m.global.addFields({ gOb: 0 })
  m.global.observeField("gOb", "cbLog")
  m.global.gOb = 2
  return m.log
end function
function alwaysNotifyTest()
  n = CreateObject("roSGNode", "Node")
  n.addField("v", "integer", false)
  n.addField("w", "integer", true)
  m.cnt = 0
  n.observeField("v", "cbCnt")
  n.observeField("w", "cbCnt")
  n.v = 1 : n.v = 1
  r = { default_same_value: m.cnt }
  m.cnt = 0
  n.w = 1 : n.w = 1
  r.true_same_value = m.cnt
  m.cnt = 0
  n.w = 2
  r.changed_value = m.cnt
  return r
end function
function unobserveTest()
  n = CreateObject("roSGNode", "Node")
  n.addField("v", "integer", false)
  m.log = ""
  n.observeField("v", "cbLog") : n.v = 1
  r = { before: m.log }
  r.ret = n.unobserveField("v")
  m.log = "" : n.v = 2
  r.after = m.log
  r.unobserve_never = n.unobserveField("v")
  return r
end function
