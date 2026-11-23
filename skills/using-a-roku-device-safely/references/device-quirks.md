# Device quirks

## doctor: is the device ready?

```bash
npx brighttest doctor --host <device-ip>          # add --json for scripts
```

It reads `query/device-info` only: no password, no lease, no keypresses. Exit 0 when every check passes, 1
when a check fails or the device does not answer. The serial number is hidden unless `--show-serial` is
passed; do not pass it in an agent run. `e2e run` runs the same check first and stops before the lease on a
Limited or developer-disabled device.

The two fixable states:

- **Limited ECP.** Set Settings, System, Advanced system settings, Control by mobile apps, Network access to
  **Permissive**. In Limited mode, keypresses and queries are refused or partial.
- **Developer mode disabled.** Enable it with the remote sequence the doctor fix text prints.

Both are device settings. Tell the human; do not guess at other settings.

## Ports

| Port | Use | Notes |
|---|---|---|
| 8060 | ECP: keypresses, `query/*` | needs Permissive; default ECP port |
| 80 | web installer: sideload, screenshot, `Delete` | needs the dev password (digest auth) |
| 8085 | BrightScript console, log capture | exactly one client; telnet or another tool blocks capture |
| 8080 | debug server | one client; `ROKU_LOG_PORT` changes the console port |

If capture fails with "Console connection is already in use", close the other client on 8085. Always use the
device IP and the default ECP port: a host name or another ECP port gives the same device a second lease key.

## Long runs stop at about 10 minutes

A long run with no key presses stalls at about 10 minutes: timers stop and the run fails, even though the
lease is valid. It is measured from the last input, not from launch. The device screensaver appears at about
601 s with no input, the likely cause (not proven).

Measured on one lab device (firmware 16.0.4.853) only: one host-side ECP `Fwd` keypress every 240 s kept the
app alive for 45 minutes. Other keys and intervals are untested.

```bash
npx brighttest device with --keepalive -- <long command>      # one key every 240 s
npx brighttest device with --keepalive=120 -- <long command>
```

Minimum 60 s, `0` is off, off by default, `device with` only (not `e2e run`). It sends nothing that moves
focus. Do not change the screensaver setting; that is the device owner's call.

## Firmware notes

- Some firmware (16.0.4, for one) reports no `video-mode`; doctor falls back to `ui-resolution`.
- The stall window above is confirmed on one firmware only. Another lab device did not start the probe app.
- Perfetto tracing enabled from Studio cannot be switched off by brighttest; do not enable it on a shared device.
- Screenshots need a sideloaded app in the foreground and the dev password configured out of band.
- Sideloading replaces the previous dev channel; that is why it must run under the lease.

## Resetting a stuck device

`npx brighttest device reset --host <device-ip>` takes the lease, sends the installer `Delete` (password from
`ROKU_PASSWORD`), presses Home and waits for the Home screen. Exit 0 when Home is reached, 1 on failure. The
sideloaded app is gone, so sideload again.
