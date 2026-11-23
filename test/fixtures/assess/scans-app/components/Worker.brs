sub init()
  m.top.functionName = "run"
end sub
sub run()
  while true
    x = CreateObject("roUrlTransfer").GetToString()
  end while
end sub
