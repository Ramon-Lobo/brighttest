sub init()
  m.top.functionName = "doWork"
end sub
sub doWork()
  m.top.progress = 1
  g = m.global
  m.top.output = "in=" + stri(m.top.input) + ";global=" + type(g) + ";gA=" + type(g.gA) + ";scene=" + type(m.top.getScene())
end sub
