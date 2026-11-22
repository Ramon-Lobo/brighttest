// Unit tests never ask a device what is in front when a lease is taken (LSE-T15 advisory): no stray requests
// to hosts like 10.0.0.x, roku.local or 127.0.0.1:8060. device-lease-foreground.test.js passes its own env.
process.env.BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK = '1'
