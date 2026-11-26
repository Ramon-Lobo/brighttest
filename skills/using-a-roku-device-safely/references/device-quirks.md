# Device quirks

Evidence: documented in `docs/guide/troubleshooting.md`, `docs/guide/device-lease.md` and `docs/guide/instrument.md`;
ports match `lib/device-hook.js`. Device-verified: only the stall and `Fwd` keepalive, on one lab device (firmware
16.0.4.853); this is a single-device observation, not verified across devices or firmware. Everything else: not
device-verified here.

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
  **Permissive**.
- **Developer mode disabled.** Enable it with the remote sequence the doctor fix text prints.

Both are device settings. Tell the human; do not guess at other settings.

## Ports

| Port | Use | Notes |
|---|---|---|
| 8060 | ECP: keypresses, `query/*` | needs Permissive; default ECP port |
| 80 | dev installer: sideload, `Delete` | needs the dev password (Digest auth) |
| 8085 | BrightScript console, log capture | exactly one client; `ROKU_LOG_PORT` changes the console port |
| 8080 | debug port | one client (the debug ports 8080 and 8085 take one client each) |
| 8087 | no brighttest lane uses it | the guard hook denies raw access to it |
| 8090 | BrightScript profile pull (`bsprof_data_dest=network`, Studio) | the guard hook denies raw access to it |

The guard hook watches all six ports (8060, 80, 8085, 8080, 8087, 8090).

If capture fails with "Console connection is already in use", close the other client on 8085. A device lane
keys the lease by the device identity (serial hash) and also holds the address key, so another address or port of
the same device still queues; if the identity read fails the lane falls back to the address key and logs it.
Still use the device IP and the default ECP port: Studio, MCP and pool picks lease by address only (`docs/guide/device-lease.md`, section on identity keys).

## Long runs stop at about 10 minutes

A long run with no key presses stalls at about 10 minutes: timers stop and the run fails, even though the
lease is valid. It is measured from the last input, not from launch. The device screensaver appears at about
601 s with no input, the likely cause (not proven).

Single-device observation, not verified across devices or firmware. Measured on one lab device (firmware 16.0.4.853) only: one host-side ECP `Fwd` keypress every 240 s kept the
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

`device reset` restarts only the dev channel. No ECP command reboots a Roku. A reboot is a human action: tell the
human and stop. Do not script the Settings menu or look for a key sequence.
