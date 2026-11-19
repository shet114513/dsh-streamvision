# dsh-streamvision

Continuous screen vision for an agent that otherwise only sees single screenshots.

The main path never puts pixels into the conversation:

**sample → SVG conversion → event writing → injected information**

Every sample writes two timestamped files at once — the raw frame (`data/samples/s_<ts>.png`) and its
vector conversion (`data/vectors/s_<ts>.svg` + `.json`) — then differences it against the previous frame
on a coarse block grid and turns the change into **events** an agent can read: how strong, where, what the
screen looks like now, whether it looks crowded, and what the previous event was. Text has its own parallel
channel (band-split OCR, no subtitle-band selection).

Small and dependency-light: Win32 GDI through [koffi](https://www.npmjs.com/package/koffi), a hand-written
PNG encoder, and the OCR engine shipped with Windows. No Python, no model weights, no network.

## What's new in 0.2.7

- **Event stream** — each event now carries `edgeDensity` (share of blocks with a strong neighbour
  contrast: <10 empty, 10–25 normal, >25 busy) next to `strength`, `where`, `scene` and `sample`.
  32×18 grid, `svg` capped at 2400 chars with the sample path kept for the full text.
- **Reading is lossless** — `sv_events` returns the *oldest unread* events, reports `pending`/`truncated`
  and the next `id`; a high-water mark in `data/events.seq` survives daemon restarts, so a stale
  `sinceId` is clamped and flagged (`staleSince`) instead of silently skipping events.
- **Text stream** — three overlapping bands (0–38% / 32–72% / 66–100%), 2× / 2× / 3×, three parallel OCR
  passes (1.2 s for a full pass). A line only enters the stream after being recognised twice ≥1.2 s apart
  with bigram similarity ≥0.85; the earlier version is kept. Unstable text never pollutes the stream.
- **Pluggable OCR** — `lib/ocr.js` resolves an engine in this order: `data/ocr.json`
  (`{cmd,args,timeoutMs}`, placeholders `{file}/{scale}/{top}/{bottom}`) → `SV_OCR_CMD` env →
  `registerOcrHook()` → Windows OCR fallback. Anything that prints `{"text": ...}` or plain text works.
- **Bounded disk** — the sample pool keeps the last 3 minutes by age (`SV_KEEP_MS`, default 180000, hard
  cap 3000), pruning the png/svg/json of a timestamp as one unit.

## What it does

- **Continuous capture** — BitBlt + nearest-neighbour downscale, ~45–65 ms per 720p frame.
- **Block differencing** — 32×18 blocks, mean absolute difference; reports which blocks moved and how much.
- **Gated events** — a still screen produces no events at all.
- **Scene segmentation / peaks** — activity runs split into scenes; `peaks` keeps the N most-changed moments.
- **Working memory** — three capacity-limited layers (`sink` / `ring` / `text`).

Motion events land in `data/events.jsonl`, recognised text in `data/text.jsonl`; the two loops are
independent, so captioning never blocks the motion channel.

## Tools

| tool | purpose |
| --- | --- |
| `sv_watch` | sample for N seconds, return a change timeline (optionally dump frames) |
| `sv_frame` | export a raw frame (the SVG conversion loses detail) |
| `sv_scenes` | sample for N seconds, cut activity into scenes or `peaks`, update working memory |
| `sv_memory` | read / append / clear the working-memory layers |
| `sv_events` | read the motion event queue; `wait` long-polls and returns the moment a new event lands |
| `sv_text` | text stream: `scan` runs one band-split OCR pass; a line enters only after being seen twice; `read` long-polls |
| `sv_arm` | arm an in-process watcher that appends events to `data/events.jsonl` |
| `sv_blocks` | read the newest SVG conversion (or sample one more with `mode:"live"`) |
| `sv_info` | screen size, armed state, frame-file accounting |

## Watching without being woken up

`sv_arm` does **not** push messages into the conversation. It samples at `fps` and appends one compact
event per meaningful change; you read the stream with a long-poll:

```js
sv_arm({ action: 'on', window: 'Game', fps: 2, cutAbs: 12, cooldownMs: 3000, idleExit: 900 })
sv_events({ wait: 60, sinceId: lastId })   // returns as soon as something lands
// → handle it, then loop again; sv_arm({ action: 'off' }) when done
```

Long-poll instead of injecting a message per event: an injected message starts a new turn, and a new turn
means re-reading the context — slower and far more expensive than staying in the same turn.

## Daemon

`sv_daemon.mjs` runs the same pipeline outside the agent loop:

```bash
node sv_daemon.mjs --window "<window title>" --seconds 60 --fps 8 --captions --captionMs 1500
```

## Install

```bash
# inside your DSH profile directory
npm install link:/path/to/dsh-streamvision
```

Add `dsh-streamvision` to your profile's `dsh.profile.bundles`, then restart DSH (plugins are not
hot-reloaded).

## Notes

- Windows only (Win32 GDI + Windows.Media.Ocr).
- The process must be DPI-aware; the plugin calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` on load.
- Capture reads screen pixels: a window that is not in front gets whatever covers it.
- Sampling only. Input and window control deliberately live elsewhere.

## License

MIT
