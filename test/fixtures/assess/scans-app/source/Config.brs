sub setup()
  cfg = {}
  cfg.apiToken = "fake-token-value-0001"
  cfg.title = "Plain title"
  cfg.password = "${PASSWORD}"
  cfg.authType = "basic"
  ' cfg.note = "just a comment"
  m.config = { clientSecret: "fake-secret-value-0002" }
  url = "https://user:fake-pass-0003@example.invalid/path"
  hdr = "Bearer fake0123456789abcdefABCDEF"
end sub
