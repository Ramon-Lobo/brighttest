function fetch(x as object, host as string) as string
    x.setUrl("https://" + host + "/p")
    return x.getUrl()
end function
