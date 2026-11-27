'use strict';
// node -r preload: any use of the network throws. Used to prove `brighttest issue` code paths stay local.
const boom = (what) => () => { throw new Error(`NETWORK USED: ${what}`); };
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
net.connect = net.createConnection = boom('net.connect');
net.Socket.prototype.connect = boom('net.Socket.connect');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[k] = boom(`dns.${k}`);
http.request = http.get = boom('http.request');
https.request = https.get = boom('https.request');
dgram.createSocket = boom('dgram.createSocket');
globalThis.fetch = boom('fetch');
