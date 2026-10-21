# Nomad DMX Desk

A cross-platform (Windows + macOS) DMX lighting desk. Outputs Art-Net and sACN (E1.31) over your network, so it works with any gateway/node – including a Boulder Box.

Original software by Corrupt Scripts. Not affiliated with any other lighting console app.

## Features

- Command line: `1 thru 10 @ 50`, `1 + 5 + 9 @ full`, `u2 1 thru 4 @ 75`, `fix 1 thru 4`, `colour red`, `@ 30`, `clear`
- Fixture patch with built-in profiles (dimmer, RGB, RGBW, RGBWW, bi-colour, pan/tilt …) and your own custom profiles
- Fixture tiles with live colour preview, colour picker, per-channel sliders (white, warm, cool, amber, UV, pan, tilt …)
- Raw channel view (512 channels per universe, up to 16 universes)
- Cue list with fade times: `record cue 3 time 2 label Walk in`, `go`, `back`, `goto 3`
- Layout tab: put fixtures on a background picture (stage plan, floor plan, photo) and draw shapes (rectangles, ellipses, triangles, lines, text). Fixtures show their live colour; drag to move, box-select to select. Effect speed is in BPM, with tap tempo.
- iPad / phone remote: turn it on in Output, open the address in Safari, enter the PIN. The computer still sends the DMX.
- 186 effects on selected fixtures, searchable by category: basic waveforms, chases, colour effects, and film effects (fire, candle, lightning, TV, police, paparazzi, faulty bulbs, explosions, sunrise and many more). Colour effects work on RGB, CCT or bi-colour fixtures.
- 1,090 film and studio fixture modes (Aputure, ARRI, Astera, Kino Flo, Lupo, Chroma-Q, LiteGear and more) from the Open Fixture Library, searchable in the Patch tab. See THIRD_PARTY_NOTICES.md.
- Grand master + blackout, Art-Net / sACN / both, unicast or broadcast / multicast
- Save/open show files (`.nomaddmx`), auto-saves and restores last show

Keyboard: `Space` = GO, `Esc` = clear, just start typing to use the command line (↑/↓ for history).

## Run it

```
npm install
npm start
npm test        # engine tests (packet formats, parser, cues, effects, UDP output)
```

## Build installers

GitHub does it for you: push to a GitHub repo, open **Actions → Build desktop apps → Run workflow**, then download the artifacts:

- Windows: `Nomad DMX Desk-…-win-x64.exe` (installer) and a portable `.exe`
- macOS: `.dmg` for Apple silicon (arm64) and Intel (x64)

Or locally: `npm run dist:win` on Windows, `npm run dist:mac` on a Mac.

### macOS note

The builds are unsigned. First launch: right-click the app → **Open** → **Open** (or System Settings → Privacy & Security → *Open Anyway*). Signing needs a paid Apple Developer account.

### Windows note

SmartScreen may warn about an unknown publisher on the unsigned installer: **More info → Run anyway**.

## Network tips

- Art-Net default destination is broadcast (`255.255.255.255`). For a single node, enter its IP on the Output tab (Boulder Box in AP mode: `192.168.4.1`).
- If you have several network adapters, set **Send from interface** to this computer's IP on the lighting network.
- Allow the app through the firewall when prompted.
- Art-Net numbering: some nodes call the first universe 0, others 1. Flip **Art-Net numbering** if nothing responds.
