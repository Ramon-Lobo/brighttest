'use strict'
// Test-only worker that exhausts its heap (exercises the PRF-06 crash path).
const keep = []
for (;;) keep.push(new Array(1e5).fill(Math.random()))
