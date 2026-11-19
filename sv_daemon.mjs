#!/usr/bin/env node
// sv_daemon.mjs - event daemon for dsh-streamvision.
// Motion events: gated by a rolling p85 threshold, grouped by quietMs, stored as numbers + one frame.
// Caption events: bottom band -> aHash dedupe -> OCR -> only when text changes.
// Both go to data/events.jsonl. Usage: node sv_daemon.mjs --window "<title>" --seconds 60
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, diffBlocks, encodePng, windowRect } from './lib/native.js'
import { scanText, ingestText } from './lib/text.js'
import { strengthOf, whereText, writeSample } from './lib/pipeline.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, 'data')
const FRAMES = path.join(DATA, 'frames')
const EVENTS = path.join(DATA, 'events.jsonl')
const SEQ_FILE = path.join(DATA, 'events.seq')
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
// 空闲自动收工：连续 idleExit 秒没有写出任何事件就退出（0 = 不退出）
const idleExit = Math.max(0, Number(arg('idleExit', 0)))
const inject = flag('inject')

fs.mkdirSync(FRAMES, { recursive: true })

const t0 = Date.now()
const means = []
const recentTimes = []
let lastRgb = null
let ev = null // 当前正在积累的事件
let lastEventEnd = 0
let frameSeq = 0 // 只给帧文件名（dump 用）
let eventSeq = 0 // 事件 id：单调递增，motion 与 caption 共用
let nMotion = 0
let nCaption = 0
let lastEventAt = Date.now() // 最近一次真正写出事件的时刻（idleExit 用）
let lastEventBrief = null // 上一个事件的摘要（事件里带 prev，方便直接推断"从什么变成什么"）

// 事件 id 跨进程续号：events.jsonl 是追加写、多天共用，重启后不能从 1 重来，
// 否则 sv_events --sinceId 会把老事件当成新的重读。
try {
  const seen = fs.readFileSync(EVENTS, 'utf8')
  for (const line of seen.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line)
      if (Number.isFinite(r.id) && r.id > eventSeq) eventSeq = r.id
    } catch {
      /* 坏行跳过 */
    }
  }
} catch {
  /* 还没有事件文件，从 0 开始 */
}
// 高水位线：sv_events{clear} 清空的是事件文件，不是 id 序列
try {
  const n = Number(fs.readFileSync(SEQ_FILE, 'utf8').trim()) || 0
  if (n > eventSeq) eventSeq = n
} catch {
  /* 还没有高水位线 */
}

// 文本流：每 captionMs 分带 OCR 一次（上/中/下，3x），交给 ingestText 做稳定判定；
// 只有"连续两拍都认到"的文字才会进 data/text.jsonl，重复的只更新 lastSeen。
const captionsOn = flag('no-captions') ? false : true
const captionMs = Number(arg('captionMs', 1500))
let capFrames = 0
let capOcr = 0
let capWritten = 0

async function captionTick() {
  if (!captionsOn) return
  let scan
  try {
    scan = await scanText({ window: windowTitle })
  } catch {
    return
  }
  capFrames++
  capOcr += (scan.bands || []).length
  const written = ingestText(scan)
  if (written.length) {
    capWritten += written.length
    lastEventAt = Date.now()
    if (inject && INBOX) {
      for (const w of written) {
        const line = {
          message_id: `sv-text-${w.id}`,
          user_id: 'streamvision',
          ts: w.ts,
          text: `[streamvision 文本·${w.band}] ${w.text.slice(0, 200)}`,
        }
        fs.appendFileSync(INBOX, JSON.stringify(line) + String.fromCharCode(10), 'utf8')
      }
    }
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
  const p = path.join(FRAMES, `ev_${String(++frameSeq).padStart(3, '0')}_${Date.now()}.png`)
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
  const mean = +(ev.sumMean / Math.max(1, ev.n)).toFixed(1)
  const strength = strengthOf(mean, ev.peak)
  const rec = {
    id: ++eventSeq,
    type: 'motion',
    t: +(now - t0) / 1000,
    at: new Date(now).toISOString(),
    durMs: ev.end - ev.start,
    strength,
    mean,
    peak: +ev.peak.toFixed(1),
    scene: ev.scene || null,
    where: ev.where || null,
    objects: ev.objects || null,
    svg: ev.svg || null,
    edgeDensity: ev.edgeDensity ?? null,
    sample: ev.sample || null,
    prev: lastEventBrief,
    blocks: ev.top,
    frame: ev.shot || null,
    window: windowTitle,
  }
  lastEventBrief = { t: rec.t, strength, scene: ev.scene || null, where: ev.where || null }
  fs.appendFileSync(EVENTS, JSON.stringify(rec) + '\n', 'utf8')
  lastEventAt = now
  nMotion++
  lastEventEnd = now
  if (inject && INBOX) {
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
let stopReason = ''

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
      // 峰值那一帧转成色块/轮廓文字（只算一次，不逐帧算）
      try {
        // 采样即转化：峰值这一帧也落成一对带时间戳的文件（原图 PNG + 转化 SVG）
        const sp = writeSample(f, { gw: 32, gh: 18, now: Date.now() })
        const v = sp.vector
        ev.sample = { png: sp.png, svg: sp.svg, ts: sp.ts }
        ev.objects = v.objects.map((o) => `${o.color}${o.share}%[${o.norm.join(',')}]`).slice(0, 5)
        ev.scene = ev.objects.slice(0, 4).join(' ')
        // 变化发生在哪、那里现在是什么颜色（比整屏色块更接近"发生了什么"）
        ev.where = whereText({ width: f.width, height: f.height, rgb: f.rgb }, d.blocks, 3)
        ev.svg = v.svg.length <= 2400 ? v.svg : null
        ev.edgeDensity = v.stats?.edgeDensity ?? null
      } catch {
        ev.scene = null
        ev.where = null
        ev.svg = null
        ev.objects = null
        ev.edgeDensity = null
      }
    }
  } else if (ev && s - t0 - ev.end > quietMs) {
    emitEvent()
  }

  // 连续 idleExit 秒没写出任何事件 → 自己收工（主人要求：静默一分钟就关）
  if (idleExit > 0 && Date.now() - lastEventAt > idleExit * 1000) {
    stopReason = 'idle'
    break
  }

  const rest = interval - (Date.now() - s)
  if (rest > 0) await new Promise((res) => setTimeout(res, rest))
}
emitEvent()
console.log(
  JSON.stringify({
    done: true,
    reason: stopReason || 'timeout',
    frames,
    gate: +gate().toFixed(1),
    events: nMotion + nCaption,
    lastId: eventSeq,
    motion: nMotion,
    captions: nCaption,
    framesSaved: frameSeq,
  }),
)
