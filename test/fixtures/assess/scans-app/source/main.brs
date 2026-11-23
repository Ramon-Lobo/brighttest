sub main(args as object)
  print "launch " + args.contentId
  r = Eval("1 + 1")
  t = CreateObject("roUrlTransfer").GetToString()
  p = CreateObject("roInput")
  i = evt.getInfo()
end sub
