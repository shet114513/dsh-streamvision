# dsh-streamvision

Continuous screen vision for an agent that otherwise only sees single screenshots.

`dsh-streamvision` samples the screen at a fixed rate, differences each frame against the previous one
on a coarse block grid, and turns that into **events** an agent can read: what moved, when it started,
when it settled. Subtitles are handled by a separate, parallel caption channel.

Small and dependency-light: Win32 GDI via [koffi](https://www.npmjs.com/package/koffi), a hand-written
PNG encoder, and the OCR engine shipped with Windows. No Python, no model weights, no network.

## What it does

- **Continuous capture** - BitBlt + nearest-neighbour downscale, ~45-65 ms per 720p frame.
- **Block differencing** - 32x18 blocks, mean absolute difference; reports which blocks moved and how much.
- **Gated events** - a rolling p85 threshold; a still screen produces no events at all.
- **Event boundaries** - motion start -> sustained -> quiet for `quietMs` closes one event.
- **Scene segmentation / peaks** - activity runs split into scenes; `peaks` keeps the N most-changed moments.
- **Caption channel** - bottom band -> aHash dedupe -> Windows OCR -> an event only when the text changes.
- **Working memory** - three capacity-limited layers (`sink` / `ring` / `text`), modelled after streaming-VLM cache design.
- **Bounded disk usage** - saved frames are pruned to a fixed number (default 60).

Motion and caption events are produced by two independent loops and land in the same `data/events.jsonl`,
distinguished by `type`. Captions never block the motion channel.

## Tools

| tool | purpose |
| --- | --- |
| `sv_watch` | sample for N seconds, return a change timeline (optionally dump frames) |
| `sv_frame` | export a frame (a fresh one if `id` is omitted) |
| `sv_scenes` | sample for N seconds, cut activity into scenes or `peaks`, update working memory |
| `sv_memory` | read / append / clear the working-memory layers |
| `sv_events` | read the event queue (motion + caption), optionally clear it |
| `sv_captions` | read or clear caption events only |
| `sv_info` | screen size, stream stats, frame-file accounting |

## Daemon

`sv_daemon.mjs` runs the same pipeline outside the agent loop and appends events as they close:

```bash
node sv_daemon.mjs --window "<window title>" --seconds 60 --fps 8 --captions --captionMs 1200
# optional: --inject   (write each event to $SV_INBOX as one JSON line)
```

## Install

```bash
# inside your DSH profile directory
npm install link:/path/to/dsh-streamvision
```

Add the plugin to your profile's `dsh.profile.bundles`, then restart DSH (plugin changes are not hot-reloaded).

## Notes

- Windows only (Win32 GDI + Windows.Media.Ocr).
- The process must be DPI-aware; the plugin calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` on load.
- Capture reads screen pixels, so a window that is not in front gets whatever covers it.
- Sampling only. Input and window control deliberately live elsewhere, so watching and acting stay independent.

## License

MIT
