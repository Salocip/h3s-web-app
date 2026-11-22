# H3S Web App

Browser control for the QCY H3S (and other QCY headsets) on Linux, using Web
Bluetooth. Protocol recovered from QCY 4.0.7. Protocols recovered from QCY 4.0.7 (`com.qcymall.qcylibrary`,
`com.jieli.jl_bt_rcsp`).

## Run

```sh
./run.sh
```

Serves this folder and launches Chromium with Web Bluetooth enabled
(`--enable-features=WebBluetooth`; Chromium on Linux keeps it off otherwise).
Or manually:

```sh
cd h3s-web-app
python3 -m http.server 8765
chromium --enable-features=WebBluetooth http://localhost:8765
```

Noise control is a single button plus a preset maker: three dropdowns pick up
to three modes (Off / Adaptive / Max / Commuting / Indoor / Anti-wind /
Transparency), stored in `localStorage` as `qcy.cycle`. The button cycles them
in strict left-to-right order starting at the first slot, wrapping back after
the last one — the device's own mode never shifts the rotation. The label still
shows the mode the device reports, and the next click is named underneath. The full preset row (Max, Commuting, Anti-wind,
Transparency, levels) sits under **Advanced: raw commands**. Each click reports `sending…`, then
`accepted, reading state…` when the device only ACKs the write, then
`applied: <preset> · mode/scene/level` from a follow-up `0xFE/0x17` read
(retried once), or an error if nothing comes back within 4 s. The H3S never
echoes the new state, so the read-back is what confirms the change. Raw
command rows and the hex console live under **Advanced: raw commands**.

Press **Connect** once: the chooser is filtered to devices that advertise a
QCY signature (`namePrefix QCY`, service `0xFEE8`, manufacturer `0x521C`), so
the classic/BR-EDR duplicate without GATT is not listed. The page then
reconnects the last working device automatically on every later load, without
a chooser. **Show all devices** is only an escape hatch for unusual models.

It works while the device is also connected over classic Bluetooth (A2DP/HFP) —
only the BLE control channel is used.

## Protocol families

Two transports are implemented; the app detects which one the device offers.

| Family | Service | Write | Notify | Used by |
| --- | --- | --- | --- | --- |
| QCY | `0000A001-…` | `00001001` | `00001002` | most QCY TWS |
| Jieli RCSP | `0000A002-…` | `00000001` | `00000002` | QCY H3S (verified) |

### QCY (0xA001)

Frame: `FF <len> { <cmd> <plen> <payload…> } …`, no checksum, no encryption.
Plain GATT reads also exist: `00000007` firmware, `00000008` battery
(3 bytes, bit 7 = charging), `0000000B` EQ.

### Jieli RCSP (0xA002)

Frame: `FE DC BA <flags> <op> <len_hi> <len_lo> <sn> <payload…> EF`.
Flags `C0` = command expecting a response, `00` = response; a response payload
is `<status> <sn> <data…>`.

QCY commands are tunnelled as RCSP **custom** commands (op `0xFF`): the payload
is the bare `<cmd> <plen> <payload…>` block, without the `FF` envelope.

Verified against a real QCY H3S:

```
TX FE DC BA C0 FF 00 04 02 FE 01 17 EF      read ANC setting
RX FE DC BA 00 FF 00 07 00 02 17 03 01 01 02 EF   mode=1 scene=1 level=2
TX FE DC BA C0 FF 00 06 03 17 03 01 05 00 EF      set adaptive ANC
RX FE DC BA 00 FF 00 02 00 03 EF                  status 0
```

The status buttons differ per family: Jieli devices get **Read state**
(`0xFE/0x17`), while **Read noise level** (`0xFE/0x07`) and **Read snapshot**
(GATT read of `0x1002`) exist only on the `0xA001` family. On the H3S the notify
characteristic `0x0002` is notify-only and the QCY `0x1002` snapshot does not
exist, so those two buttons are hidden instead of failing silently.

Battery on Jieli uses RCSP `GetSysInfo` (op `0x07`, function `0xFF`, mask `1`):

```
TX FE DC BA C0 07 00 06 00 FF 00 00 00 01 EF
RX FE DC BA 00 07 00 06 00 00 FF 02 00 5F EF   -> 95%
```

## Commands used

| cmd | payload | meaning |
| --- | --- | --- |
| `0x07` | `FF` | read noise level |
| `0x0C` | `m` | noise mode (1 = ANC, 2 = transparency class) |
| `0x17` | `m s v` | ANC setting: mode, scene, level |
| `0x2F` | 3 bytes | battery (0xA001 path only) |
| `0x30` | 3 bytes | firmware `major.minor.patch` |
| `0xFE` | `id` | request a setting; the response carries the same `id` |

ANC presets come from QCY's H3S control-panel JSON (`modelId 16764`,
`product/findControlPanels` on `api.watch.qcy.com`):

| preset | cmd 23 bytes |
| --- | --- |
| Off (normal) | `2 0 0` |
| Adaptive ANC | `1 5 0` |
| Noisy | `1 1 0..2` |
| Commuting | `1 2 0..2` |
| Indoor | `1 3 0..2` |
| Anti-wind | `1 4 0` |
| Transparency | `3 1 4` |

## Equalizer

Presets come from the H3S control-panel layout `type: 2` (10 bands at
32 Hz-16 kHz, gains stored as dB*10 in a signed byte):

| id | preset |
| --- | --- |
| 1 | Spatial |
| 2 | Default |
| 3 | Pop |
| 4 | Heavy Bass |
| 5 | Rock |
| 6 | Soft |
| 7 | Classic |
| 128 / 0xFF | Vocal boost (custom curve: -3,-4,-5,-1,3,7,6,3,0,-2 dB) |

Jieli devices use QCY command `0x22` (34) with a parametric payload:
`[type][master gain ×100][10 × (freq, gain ×100, Q ×100, type)]`. Reads use
`0xFE/0x22`. This was verified on the H3S: writing preset `3` read back with
`type=3` and the exact gains. `0xA001` devices write characteristic `0000000B`
with `[id, gains…]` instead.

The selected equalizer is stored in `localStorage` (`qcy.eq`) and re-applied on
every connect, so it survives reloads, reconnects and switching the headset
between hosts (multipoint). Note this also overrides an equalizer set from the
phone app on the next connect.

## Firmware

**Check for updates** reads the firmware from the headset and reports it. QCY
serves OTA only through the mobile app: `earphoneoOta/findEarphoneoOta`
returns `401 Login expired` without an account token, the product database has
no firmware URLs, and the endpoint sends no CORS headers. Flashing is therefore
not implemented.

## Limitations

- Only the two families above. BES (`77777777-…`), Actions (`e49a25f8-…`),
  Xiaomi (`0xAF00…`) and the Wuqi CLI service (`0x7033`) are not implemented.
- Equalizer writes were verified against captured app frames and a device
  mock, not yet against live hardware (the headset was not advertising LE
  during the last test); the read-back status tells you whether the device
  accepted the mode.
- Web Bluetooth on Linux is behind Chromium's `WebBluetooth` feature flag and
  needs BlueZ. Firefox is unsupported.
- Chrome's BlueZ view contains both a named classic/BR-EDR object (no GATT) and
  an unnamed LE control interface advertising service `0xFEE8` plus
  manufacturer id `0x521C`. The primary chooser filters on those, so only the
  usable LE entry appears.

## Test

```sh
npm test
```
