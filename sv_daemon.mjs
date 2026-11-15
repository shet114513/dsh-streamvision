#!/usr/bin/env node
// sv_daemon.mjs - event daemon for dsh-streamvision.
// Motion events: gated by a rolling p85 threshold, grouped by quietMs, stored as numbers + one frame.
// Caption events: bottom band -> aHash dedupe -> OCR -> only when text changes.
// Both go to data/events.jsonl. Usage: node sv_daemon.mjs --window "<title>" --seconds 60
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, diffBlocks, encodePng, windowRect } from './lib/native.js'
import { bandRect, bandHash, ocrImage } from './lib/caption.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, 'data')
const FRAMES = path.join(DATA, 'frames')
const EVENTS = path.join(DATA, 'events.jsonl')
const INBOX = process.env.SV_INBOX || ''

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const flag = (name) => argv.includes('--' + name)

const windowTitle = arg('window', '')
const seconds = Math.max(1, Number(arg('seconds', 60)))
const fps = Math.min(30, Math.max(1, Number(arg('fps', 8))))
const maxHeight = Number(arg('maxHeight', 480))
const cooldownMs = Number(arg('cooldown', 2000))
const quietMs = Number(arg('quiet', 700))
const maxPerMin = Number(arg('maxPerMin', 8))
const inject = flag('inject')

fs.mkdirSync(FRAMES, { recursive: true })

const t0 = Date.now()
const means = []
const recentTimes = []
let lastRgb = null
let ev = null // 当前正在积累的事件
let lastEventEnd = 0
let seq = 0

// 每 captionMs 采一次底部字幕带：aHash 相同就跳过，OCR 文本也相同就不记；
// 只有文本真的变了才落一条 {type:'caption'}，和画面事件写同一个队列。
const captionsOn = flag('captions') || flag('inject')
const captionMs = Number(arg('captionMs', 1200))
let capState = { lastHash: '', lastText: '' }
let capFrames = 0
let capOcr = 0
let capSeq = 0

async function captionTick() {
  if (!captionsOn) return
  const rect = bandRect({ window: windowTitle })
  let shot
  try {
    shot = capture({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, outW: rect.width, outH: rect.height })
  } catch {
    return
  }
  capFrames++
  const hash = bandHash(shot.rgb, shot.width, shot.height)
  if (hash === capState.lastHash) return
  capState.lastHash = hash
  const tmp = path.join(DATA, `cap_${Date.now()}.png`)
  fs.writeFileSync(tmp, encodePng({ width: shot.width, height: shot.height, rgb: shot.rgb }))
  const res = ocrImage(tmp, { cropTop: 0, cropBottom: 1, scale: 3 })
  capOcr++
  try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  if (!res || !res.ok || !res.text || res.text === capState.lastText) return
  capState.lastText = res.text
  const now = Date.now()
  const rec = {
    id: ++capSeq,
    type: 'caption',
    source: 'ocr',
    text: res.text,
    t: Math.round(now / 1000),
    durMs: captionMs,
  }
  rec.type = rec.type || 'motion'
  fs.appendFileSync(EVENTS, JSON.stringify(rec) + '\n', 'utf8')
  if (inject) {
    const line = { prompt: `【screenvision 字幕】${res.text.slice(0, 160)}` }
    fs.appendFileSync(INBOX, JSON.stringify(line) + '\n', 'utf8')
  }
}

const captionTimer = setInterval(() => {
  captionTick().catch(() => {})
}, captionMs)
if (typeof captionTimer.unref === 'function') captionTimer.unref()

const pct = (arr, p) => {
  const a = arr.slice().sort((x, y) => x - y)
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0
}

function gate() {
  // 门限 = 最近样本的 p85，再兜一个下限：静止画面里几乎不可能越过 4
  const p = pct(means.slice(-40), 0.85)
  return Math.max(4, p * 1.15)
}

function dump(rgb, w, h) {
  const p = path.join(FRAMES, `ev_${String(++seq).padStart(3, '0')}_${Date.now()}.png`)
  fs.writeFileSync(p, encodePng({ width: w, height: h, rgb }))
  return p
}

function emitEvent() {
  if (!ev) return
  const now = Date.now()
  if (now - lastEventEnd < cooldownMs) {
    ev = null
    return
  }
  recentTimes.push(now)
  const perMin = recentTimes.filter((t) => now - t <= 60000).length
  if (perMin > maxPerMin) {
    ev = null
    return
  }
  const rec = {
    id: seq,
    t: +(now - t0) / 1000,
    at: new Date(now).toISOString(),
    durMs: ev.end - ev.start,
    mean: +(ev.sumMean / Math.max(1, ev.n)).toFixed(1),
    peak: +ev.peak.toFixed(1),
    blocks: ev.top,
    frame: ev.shot || null,
    window: windowTitle,
  }
  rec.type = rec.type || 'motion'
  fs.appendFileSync(EVENTS, JSON.stringify(rec) + '\n', 'utf8')
  lastEventEnd = now
  if (inject) {
    const text =
      `[streamvision] ${rec.t.toFixed(1)}s 处画面出现变化：持续 ${(rec.durMs / 1000).toFixed(1)}s，` +
      `幅度 ${rec.mean}（峰 ${rec.peak}），变化集中在 ${rec.blocks.map((b) => `${b.x},${b.y}`).join(' / ')}。` +
      `要看细节用 sv_events 取帧。`
    const line = {
      message_id: `sv-${now}-${rec.id}`,
      user_id: 'streamvision',
      ts: new Date(now).toISOString(),
      text,
    }
    fs.appendFileSync(INBOX, JSON.stringify(line) + '\n', 'utf8')
  }
  console.log(JSON.stringify(rec))
  ev = null
}

const interval = Math.max(30, Math.round(1000 / fps))
const end = t0 + seconds * 1000
let frames = 0

while (Date.now() < end) {
  const s = Date.now()
  const r = windowRect(windowTitle)
  const region = r ? { x: r.x, y: r.y, width: r.width, height: r.height } : {}
  let f = null
  try {
    f = capture({ ...region, maxHeight })
  } catch {
    await new Promise((res) => setTimeout(res, interval))
    continue
  }
  frames++
  const d = lastRgb ? diffBlocks(lastRgb, f) : { mean: 0, peak: 0, blocks: [] }
  lastRgb = f
  means.push(d.mean)
  if (means.length > 240) means.shift()

  const g = gate()
  if (d.mean >= g || d.peak >= g * 4) {
    const t = s - t0
    if (!ev) ev = { start: t, end: t, sumMean: 0, n: 0, peak: 0, top: [], shot: null }
    ev.end = t
    ev.sumMean += d.mean
    ev.n++
    if (d.peak >= ev.peak) {
      ev.peak = d.peak
      ev.top = d.blocks.slice(0, 3).map((b) => ({ x: b.x, y: b.y, v: +b.v.toFixed(1) }))
      ev.shot = dump(f.rgb, f.width, f.height)
    }
  } else if (ev && s - t0 - ev.end > quietMs) {
    emitEvent()
  }

  const rest = interval - (Date.now() - s)
  if (rest > 0) await new Promise((res) => setTimeout(res, rest))
}
emitEvent()
console.log(JSON.stringify({ done: true, frames, gate: +gate().toFixed(1), events: seq }))
