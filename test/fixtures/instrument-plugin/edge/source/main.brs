sub main()
    #if BT_AGENT
    print "agent build"
    #else
    print "plain build"
    #end if
    o = createObject("roUrlTransfer")
    o["setUrl"]("https://example.test/idx")
    o["GETURL"]()
    o.getUrl()
    o.setUrl("https://example.test/dot")
end sub
