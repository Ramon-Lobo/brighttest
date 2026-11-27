'use strict'
// Generic fake of the Roku dev installer for tests (no real host, no real password): a local http server that closes
// the socket right after the 401 challenge without announcing it, and accepts the archive only when authenticated.
//
//   const f = await fakeInstaller({ failAuthPostsBy: [1] })   // destroy the socket on the Nth authenticated POST
//   f.port, f.srv, f.log = { reqs: [{ authed, submit, bytes }], sockets: [remotePort], bytesBeforeAuth }
//   toLocal(port)  -> a fetch that routes :80 installer URLs to the local server and answers ECP active-app with "dev"
const http = require('node:http')

const challenge = 'Digest realm="rokudev", nonce="abc", qop="auth"'

function fakeInstaller({ failAuthPostsBy = [] } = {}) {
  const log = { reqs: [], sockets: [], bytesBeforeAuth: 0 }
  let authN = 0
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1')
      const authed = !!req.headers.authorization
      const submit = (/name="mysubmit"\r\n\r\n(\w+)/.exec(body) || [])[1] || null
      log.reqs.push({ authed, submit, bytes: chunks.reduce((n, c) => n + c.length, 0) })
      log.sockets.push(req.socket.remotePort)
      if (!authed) {
        log.bytesBeforeAuth += Buffer.concat(chunks).length
        res.writeHead(401, { 'WWW-Authenticate': challenge })
        res.end('')
        setTimeout(() => req.socket.destroy(), 5)
        return
      }
      authN++
      if (failAuthPostsBy.includes(authN)) { req.socket.destroy(); return }
      res.writeHead(200)
      res.end(submit === 'Delete' ? 'Delete done' : 'Install Success')
    })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, log, port: srv.address().port })))
}

// Route the installer URL (port 80) to the local server; ECP polls answer "dev".
const toLocal = (port) => (url, init) => {
  if (/:8060\/query\/active-app$/.test(url)) return Promise.resolve({ status: 200, headers: { get: () => null }, text: async () => '<active-app><app id="dev">S</app></active-app>' })
  return fetch(url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${port}`), init)
}

module.exports = { fakeInstaller, toLocal, challenge }
