'use strict'
// Test-only worker that throws an error whose message contains an absolute path.
throw new Error('boom at /Users/someone/secret/place.js')
