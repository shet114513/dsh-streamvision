// Tool registration for the host (sv_* tools).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, diffBlocks, encodePng, screenSize, windowRect } from './native.js'
import { clearCaptions, readCaptions, watchCaptions } from './caption.js'

export const name = 'dsh-streamvision'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'data')
const FRAMES = path.join(DATA, 'frames')
const STREAMS = new Map()
let seq = 0
// 落盘采样上限：超过就把最旧的删掉（默认 60 张）
const MAX_FRAME_FILES = Number(process.env.SV_MAX_FRAMES || 60)
const WORKMEM = path.join(DATA, 'workmem.json')
// 仿 StreamingVLM 的三层工作记忆（不碰模型 KV，只用文件模拟相同的取舍）：
const MEM_DEFAULT = { sink: [], ring: [], text: [], updatedAt: 0 }

function loadMem() {
  try {
    const m = JSON.parse(fs.readFileSync(WORKMEM, 'utf8'))
    return { ...MEM_DEFAULT, ...m }
  } catch {
    return { ...MEM_DEFAULT }
  }
}

function saveMem(m) {
  m.updatedAt = Date.now()
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(WORKMEM, JSON.stringify(m, null, 1))
  return m
}

function ensureDirs() {
  fs.mkdirSync(FRAMES, { recursive: true })
}

function regionOf(region) {
  if (!region) return {}
  const { x, y, width, height } = region
  return { x: x | 0, y: y | 0, width: width | 0 || undefined, height: height | 0 || undefined }
}

/** 起一个后台流：每隔 intervalMs 抓一帧、算差分、压进环形缓冲。 */
function startStream({ fps = 8, threshold = 6, region, outW, maxHeight = 720, keep = 60 } = {}) {
  ensureDirs()
  const id = `sv${++seq}`
  const interval = Math.max(50, Math.round(1000 / Math.max(0.5, Math.min(30, fps))))
  const st = {
    id,
    fps: 1000 / interval,
    threshold,
    region: regionOf(region),
    outW,
    maxHeight,
    keep,
    frames: [],
    events: [],
    startedAt: Date.now(),
    lastRgb: null,
    hits: 0,
    errors: 0,
    timer: null,
    stats: { captured: 0, elapsedSum: 0 },
  }
  const tick = () => {
    const t0 = Date.now()
    try {
      const frame = capture({ ...geo(st), outW: st.outW, maxHeight: st.maxHeight })
      const d = st.lastRgb ? diffBlocks(st.lastRgb, frame) : { blocks: [], changed: 0, mean: 0, peak: 0 }
      const rec = { t: t0, w: frame.width, h: frame.height, rgb: frame.rgb, mean: d.mean, peak: d.peak, changed: d.changed }
      st.lastRgb = frame
      st.frames.push(rec)
      if (st.frames.length > st.keep) st.frames.shift()
      if (d.mean >= st.threshold || d.peak >= st.threshold * 4) {
        st.hits++
        st.events.push({ t: t0, mean: d.mean, peak: d.peak, changed: d.changed, top: d.blocks.slice(0, 5), cells: d.cells })
        if (st.events.length > 500) st.events.shift()
      }
      st.stats.captured++
      st.stats.elapsedSum += Date.now() - t0
    } catch (err) {
      st.errors++
      st.lastError = String(err && err.message ? err.message : err)
    }
  }
  st.timer = setInterval(tick, interval)
  if (st.timer.unref) st.timer.unref()
  STREAMS.set(id, st)
  tick()
  return st
}

function streamInfo(st) {
  const last = st.frames[st.frames.length - 1]
  return {
    id: st.id,
    fps: Math.round(st.fps * 10) / 10,
    threshold: st.threshold,
    running: Boolean(st.timer),
    captured: st.stats.captured,
    avgMs: st.stats.captured ? Math.round((st.stats.elapsedSum / st.stats.captured) * 10) / 10 : 0,
    events: st.events.length,
    hits: st.hits,
    errors: st.errors,
    lastError: st.lastError,
    maxHeight: st.maxHeight,
    frameFiles: countFrames(),
    bufferedFrames: st.frames.length,
    spanSec: st.frames.length > 1 ? Math.round(((last.t - st.frames[0].t) / 1000) * 10) / 10 : 0,
    size: last ? [last.w, last.h] : null,
  }
}

/** 只保留最新的 MAX_FRAME_FILES 张 PNG，旧的删掉。 */
function pruneFrames() {
  try {
    const files = fs
      .readdirSync(FRAMES)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => ({ f, t: fs.statSync(path.join(FRAMES, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of files.slice(MAX_FRAME_FILES)) {
      try {
        fs.unlinkSync(path.join(FRAMES, old.f))
      } catch {
        /* 删不掉就算了，下次再删 */
      }
    }
    return files.length
  } catch {
    return 0
  }
}

function countFrames() {
  try {
    return fs.readdirSync(FRAMES).filter((f) => f.toLowerCase().endsWith('.png')).length
  } catch {
    return 0
  }
}

// 取这一次该拍哪块：优先按窗口标题（每帧重算，窗口能跟着动），其次 region，最后整屏。

function geo(args) {
  let g = {}
  if (args && args.window) {
    const r = windowRect(args.window)
    if (r) g = { x: r.x, y: r.y, width: r.width, height: r.height, followed: args.window }
  }
  if (!g.width && args && args.region) g = { ...args.region }
  // 常用取景：只盯台词/字幕那条带（窗口底部 24%），读对白用
  if (args && (args.preset === 'bottom' || args.preset === 'dialogue') && g.height) {
    return { x: g.x || 0, y: Math.round((g.y || 0) + g.height * 0.76), width: g.width, height: Math.max(40, Math.round(g.height * 0.24)) }
  }
  return g
}

function dumpFrame(st, rec, file) {
  ensureDirs()
  const p = file ? path.resolve(file) : path.join(FRAMES, `sv_${st.id}_${rec.t}.png`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, encodePng({ width: rec.w || rec.width, height: rec.h || rec.height, rgb: rec.rgb }))
  pruneFrames()
  return p
}

const textOut = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }]
const OUTPUT = { schema: { type: 'string' }, render: (_a, v) => textOut(v) }

// 宿主强制要求每个工具声明 output；这里统一包一层：结果序列化成 JSON 字符串
function reg(ctx, spec) {
  const inner = spec.execute
  ctx.tools.register({
    ...spec,
    output: OUTPUT,
    execute: async (args) => {
      try {
        return JSON.stringify(await inner(args || {}), null, 1)
      } catch (e) {
        return JSON.stringify({ status: 'error', error: String(e && e.message ? e.message : e) })
      }
    },
  })
}

export function apply(ctx) {
  reg(ctx, {
    name: 'sv_watch',
    description:
      'Watch the screen for a fixed time (blocking). Captures at `fps`, diffs each frame against the previous one on a block grid, ' +
      'and returns a change timeline: when the picture moved, how much, and which blocks moved. Answers "what just happened" ' +
      'far better than a single screenshot. Use `region` to watch only part of the screen.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to watch, in seconds. Default 5, max 60.' },
        fps: { type: 'number', description: 'Frames per second. Default 8, range 0.5-30.' },
        threshold: { type: 'number', description: 'Mean block difference that counts as motion. Default 6.' },
        maxHeight: { type: 'number', description: 'Quality: max frame height. Default 720 (smaller is faster, 1080 = full HD).' },
        outW: { type: 'number', description: 'Optional: specify quality by width instead of maxHeight.' },
        dump: { type: 'boolean', description: 'When true, saves the 3 highest-change frames to disk and returns their paths.' },
        region: {
          type: 'object',
          description: 'Watch only this region: {x,y,width,height}.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
    },
    async execute(args = {}) {
      const seconds = Math.max(0.5, Math.min(60, args.seconds || 5))
      const fps = Math.max(0.5, Math.min(30, args.fps || 8))
      const threshold = args.threshold || 6
      const thr = threshold
      const maxHeight = args.maxHeight || 720
      const interval = Math.max(50, Math.round(1000 / fps))
      const region = regionOf(args.region)
      const frames = []
      const events = []
      const t0 = Date.now()
      const end = t0 + seconds * 1000
      let lastRgb = null
      let captured = 0
      let errors = 0
      let elapsedSum = 0
      while (Date.now() < end) {
        const s = Date.now()
        try {
          const f = capture({ ...geo(args), outW: args.outW, maxHeight })
          const d = lastRgb ? diffBlocks(lastRgb, f) : { blocks: [], changed: 0, mean: 0, peak: 0, cells: 0 }
          lastRgb = f
          captured++
          frames.push({ t: s, ...f, mean: d.mean })
          if (d.mean >= threshold || d.peak >= threshold * 4) {
            events.push({ ms: s - t0, mean: d.mean, peak: d.peak, changed: d.changed, top: d.blocks.slice(0, 3) })
          }
          elapsedSum += Date.now() - s
        } catch (err) {
          errors++
        }
        const rest = interval - (Date.now() - s)
        if (rest > 0) await new Promise((r) => setTimeout(r, rest))
      }
      const out = {
        seconds,
        fps,
        threshold,
        captured,
        avgMs: captured ? Math.round((elapsedSum / captured) * 10) / 10 : 0,
        errors,
        size: frames.length ? [frames[0].width, frames[0].height] : null,
        events: events.length,
        eventList: events.slice(0, 20),
        quiet: events.length === 0,
      }
      if (args.dump && frames.length) {
        const picks = events.length ? events.slice(0, 3).map((e) => e.ms) : [0]
        out.dumped = picks.map((ms) => {
          const rec = frames.reduce((best, f) => (Math.abs(f.t - t0 - ms) < Math.abs(best.t - t0 - ms) ? f : best), frames[0])
          return dumpFrame({ id: 'watch' }, rec)
        })
      }
      return out
    },
  })

  reg(ctx, {
    name: 'sv_frame',
    description: 'Export a buffered frame at a given moment as PNG (latest frame when `t` is omitted). Without `id`, grabs a fresh frame. Returns the file path.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stream id; omit to capture a fresh frame.' },
        t: { type: 'number', description: 'Timestamp (ms); the closest buffered frame is used.' },
        path: { type: 'string', description: 'Custom output path.' },
        maxHeight: { type: 'number', description: 'Quality for a fresh capture (max frame height, default 720).' },
        outW: { type: 'number', description: 'Width for a fresh capture (defaults to maxHeight 720).' },
      },
    },
    async execute(args = {}) {
      if (!args.id) {
        const f = capture({ ...geo(args), outW: args.outW, maxHeight: args.maxHeight || 720 })
        const p = args.path ? path.resolve(args.path) : path.join(FRAMES, `sv_snap_${Date.now()}.png`)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, encodePng(f))
        pruneFrames()
        return { path: p, size: [f.width, f.height] }
      }
      const st = STREAMS.get(args.id)
      if (!st || !st.frames.length) return { status: 'error', error: `no frames for stream: ${args.id}` }
      const target = args.t || st.frames[st.frames.length - 1].t
      const rec = st.frames.reduce((best, f) => (Math.abs(f.t - target) < Math.abs(best.t - target) ? f : best), st.frames[0])
      return { path: dumpFrame(st, rec, args.path), t: rec.t, size: [rec.w, rec.h] }
    },
  })

  reg(ctx, {
    name: 'sv_scenes',
    description:
      'Watch for a while, split activity into scenes (a quiet gap ends a scene), keep one representative frame per scene, ' +
      'and update working memory (sink anchors + recent ring + text notes). Returns scenes with start/end, duration, peak change ' +
      'and frame path — answers "what happened, in how many phases".',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to watch, in seconds. Default 6, max 60.' },
        fps: { type: 'number', description: 'Frames per second. Default 8.' },
        threshold: { type: 'number', description: 'Mean block difference that counts as motion. Default 6.' },
        maxHeight: { type: 'number', description: 'Quality (max frame height). Default 720.' },
        quietMs: { type: 'number', description: 'Quiet gap that ends a scene, in ms. Default 400.' },
        mode: { type: 'string', enum: ['scenes', 'peaks'], description: 'scenes = split by quiet gaps (static windows). peaks = keep the N most-changed moments, spaced apart (animated windows like games).' },
        peaks: { type: 'number', description: 'With mode=peaks: how many moments to keep. Default 6.' },
        minGapMs: { type: 'number', description: 'With mode=peaks: minimum spacing between kept moments. Default 800.' },
        preset: { type: 'string', enum: ['bottom', 'dialogue'], description: 'Convenience crop: bottom = the bottom 24% band of the window (subtitle / caption area). dialogue is a legacy alias.' },
        dump: { type: 'boolean', description: 'Save one representative frame per scene (default true).' },
        note: { type: 'string', description: 'Optional note for this observation; stored in the text layer.' },
        sinkKeep: { type: 'number', description: 'How many scenes the sink layer keeps. Default 3.' },
        ringKeep: { type: 'number', description: 'How many scenes the ring layer keeps. Default 24.' },
        textLimit: { type: 'number', description: 'Max entries in the text layer. Default 40.' },
        reset: { type: 'boolean', description: 'When true, clears working memory before observing.' },
      },
    },
    async execute(args = {}) {
      const seconds = Math.max(0.5, Math.min(60, args.seconds || 6))
      const fps = Math.max(0.5, Math.min(30, args.fps || 8))
      const threshold = args.threshold || 6
      const thr = threshold
      const maxHeight = args.maxHeight || 720
      const quietMs = Math.max(100, args.quietMs || 400)
      const dump = args.dump !== false
      const mem = args.reset ? { ...MEM_DEFAULT } : loadMem()
      const t0 = Date.now()
      const end = t0 + seconds * 1000
      const interval = Math.max(50, Math.round(1000 / fps))
      let lastRgb = null
      let cur = null
      const scenes = []
      const peaks = []
      const closeScene = () => {
        if (!cur) return
        cur.durMs = cur.lastActive - cur.start
        scenes.push(cur)
        cur = null
      }
      let captured = 0
      while (Date.now() < end) {
        const s = Date.now()
        try {
          const f = capture({ ...geo(args), maxHeight })
          const d = lastRgb ? diffBlocks(lastRgb, f) : { mean: 0, peak: 0, changed: 0, blocks: [] }
          lastRgb = f
          captured++
          if (args.mode === 'peaks' && d.mean > 0) {
            peaks.push({ t: s - t0, mean: d.mean, peak: d.peak, blocks: d.blocks, shot: f })
            if (peaks.length > 40) {
              peaks.sort((a, b) => a.mean - b.mean)
              peaks.shift()
            }
          }
          const active = d.mean >= thr || d.peak >= thr * 4
          if (active) {
            if (!cur) cur = { start: s - t0, lastActive: s - t0, peak: d.peak, frames: 0, shot: null }
            cur.lastActive = s - t0
            cur.frames++
            if (d.peak >= cur.peak) {
              cur.peak = Math.round(d.peak * 10) / 10
              cur.shot = f
              cur.top = d.blocks.slice(0, 3)
            }
          } else if (cur && s - t0 - cur.lastActive > quietMs) {
            closeScene()
          }
        } catch {
          /* 单帧失败不致命 */
        }
        const rest = interval - (Date.now() - s)
        if (rest > 0) await new Promise((r) => setTimeout(r, rest))
      }
      closeScene()

      // mode=peaks：在"一直在动"的画面上不做场景切分，改保留最值得看的 N 个瞬间
      if (args.mode === 'peaks') {
        const keepN = Math.max(1, Math.min(20, args.peaks || 6))
        const gap = Math.max(100, args.minGapMs || 800)
        const chosen = []
        for (const cand of peaks.slice().sort((a, b) => b.mean - a.mean)) {
          if (chosen.length >= keepN) break
          if (chosen.every((c) => Math.abs(c.t - cand.t) >= gap)) chosen.push(cand)
        }
        const picked = chosen.sort((a, b) => a.t - b.t)
        const out = picked.map((p, i) => {
          const rec = { id: `p${i + 1}`, atMs: p.t, mean: Math.round(p.mean * 10) / 10, peak: Math.round(p.peak * 10) / 10, top: p.blocks.slice(0, 3) }
          if (dump) rec.frame = dumpFrame({ id: 'peak' }, { ...p.shot, t: Date.now() + i, w: p.shot.width, h: p.shot.height })
          return rec
        })
        const mem = args.reset ? { ...MEM_DEFAULT } : loadMem()
        for (const sc of out) {
          const entry = { t: Date.now() + sc.atMs, durMs: 0, peak: sc.peak, frame: sc.frame || null }
          if (mem.sink.length < (args.sinkKeep || 3)) mem.sink.push(entry)
          else {
            mem.ring.push(entry)
            const ringKeep = args.ringKeep || 24
            if (mem.ring.length > ringKeep) mem.ring = mem.ring.slice(-ringKeep)
          }
        }
        if (args.note) {
          mem.text.push({ t: Date.now(), text: String(args.note).slice(0, 400) })
          if (mem.text.length > (args.textLimit || 40)) mem.text = mem.text.slice(-(args.textLimit || 40))
        }
        saveMem(mem)
        return { mode: 'peaks', seconds, fps, captured, kept: out.length, peaks: out, memory: { sink: mem.sink.length, ring: mem.ring.length, text: mem.text.length, file: WORKMEM } }
      }

      const out = scenes.map((sc, i) => {
        const rec = {
          id: `s${i + 1}`,
          startMs: sc.start,
          endMs: sc.lastActive,
          durMs: sc.durMs,
          peak: sc.peak,
          frames: sc.frames,
          top: sc.top || [],
        }
        if (dump && sc.shot) {
          rec.frame = dumpFrame({ id: 'scene' }, { ...sc.shot, t: Date.now(), w: sc.shot.width, h: sc.shot.height })
        }
        return rec
      })
      // 更新三层记忆
      for (const sc of out) {
        const entry = { t: Date.now() + sc.startMs, durMs: sc.durMs, peak: sc.peak, frame: sc.frame || null }
        if (mem.sink.length < (args.sinkKeep || 3)) mem.sink.push(entry)
        else {
          mem.ring.push(entry)
          const ringKeep = args.ringKeep || 24
          if (mem.ring.length > ringKeep) mem.ring = mem.ring.slice(-ringKeep)
        }
      }
      if (args.note) {
        mem.text.push({ t: Date.now(), text: String(args.note).slice(0, 400) })
        const textLimit = args.textLimit || 40
        if (mem.text.length > textLimit) mem.text = mem.text.slice(-textLimit)
      }
      saveMem(mem)
      return {
        seconds,
        captured,
        scenes: out,
        sceneCount: out.length,
        memory: { sink: mem.sink.length, ring: mem.ring.length, text: mem.text.length, file: WORKMEM },
      }
    },
  })

  reg(ctx, {
    name: 'sv_memory',
    description: 'Read or edit working memory: read shows three layers (sink anchors / ring of recent scenes / text notes); add appends a note; clear empties a layer. Capacity is fixed — the oldest entries are evicted first.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'add', 'clear'], description: 'Defaults to read.' },
        text: { type: 'string', description: 'Text to append (action=add).' },
        layer: { type: 'string', enum: ['text', 'ring', 'sink', 'all'], description: 'Which layer to clear. Default text.' },
      },
    },
    async execute(args = {}) {
      const action = args.action || 'read'
      const mem = loadMem()
      if (action === 'clear') {
        const layer = args.layer || 'text'
        if (layer === 'all') saveMem({ ...MEM_DEFAULT })
        else {
          mem[layer] = []
          saveMem(mem)
        }
        return { cleared: layer, memory: { sink: mem.sink.length, ring: mem.ring.length, text: mem.text.length } }
      }
      if (action === 'add') {
        if (!args.text) return { status: 'error', error: 'text is required for add' }
        mem.text.push({ t: Date.now(), text: String(args.text).slice(0, 400) })
        if (mem.text.length > 40) mem.text = mem.text.slice(-40)
        saveMem(mem)
        return { added: true, textCount: mem.text.length }
      }
      return { sink: mem.sink, ring: mem.ring.slice(-8), text: mem.text.slice(-8), counts: { sink: mem.sink.length, ring: mem.ring.length, text: mem.text.length }, updatedAt: mem.updatedAt }
    },
  })

  reg(ctx, {
    name: 'sv_events',
    description:
      'Read the background event queue written by the event daemon (sv_daemon.mjs). Only *meaningful* changes are recorded, ' +
      'each one compact: time, duration, magnitude, which blocks moved, and one representative frame path. ' +
      'Use this instead of re-watching when a [streamvision] event hint arrived in the conversation.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many most-recent events to return. Default 5, max 30.' },
        sinceId: { type: 'number', description: 'Only events with id greater than this.' },
        clear: { type: 'boolean', description: 'Truncate the queue after reading (default false).' },
      },
    },
    async execute(args = {}) {
      const file = path.join(DATA, 'events.jsonl')
      let rows = []
      try {
        rows = fs
          .readFileSync(file, 'utf8')
          .split(String.fromCharCode(10))
          .filter((l) => l.trim() !== '')
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean)
      } catch {
        return { events: [], total: 0, note: 'no events yet (daemon not run?)', file }
      }
      const since = Number(args.sinceId || 0)
      const pool = since ? rows.filter((r) => Number(r.id || 0) > since) : rows
      const limit = Math.max(1, Math.min(30, args.limit || 5))
      const out = pool.slice(-limit)
      if (args.clear) {
        try {
          fs.writeFileSync(file, '', 'utf8')
        } catch {
          /* ignore */
        }
      }
      return { total: rows.length, returned: out.length, cleared: args.clear === true, events: out }
    },
  })

  reg(ctx, {
    name: 'sv_captions',
    description: 'Subtitle/caption event source (local Windows OCR, offline). action=watch samples the bottom caption band, skips frames whose pixels did not change, and appends one caption.final event only when the recognised text actually changes. action=list returns recent events, action=clear empties them.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['watch', 'list', 'clear'], description: 'Default watch.' },
        seconds: { type: 'number', description: 'watch: how long to watch, default 30, max 600.' },
        intervalMs: { type: 'number', description: 'watch: sampling interval in ms, default 1200.' },
        window: { type: 'string', description: 'watch: window title fragment; omit to use the whole screen.' },
        top: { type: 'number', description: 'watch: band top as a fraction of the height, default 0.82.' },
        bottom: { type: 'number', description: 'watch: band bottom fraction, default 0.95.' },
        keepX: { type: 'number', description: 'watch: horizontal span kept, default 0.9 of the width.' },
        scale: { type: 'number', description: 'watch: upscale before OCR, default 3 (small text needs it).' },
        since: { type: 'number', description: 'list: only events with id greater than this.' },
        limit: { type: 'number', description: 'list: max events, default 50.' },
      },
    },
    async execute(args = {}) {
      const action = args.action || 'watch'
      if (action === 'clear') {
        clearCaptions()
        return { ok: true, cleared: true }
      }
      if (action === 'list') {
        const events = readCaptions({ since: args.since || 0, limit: Math.max(1, Math.min(500, args.limit || 50)) })
        return { ok: true, count: events.length, events }
      }
      const r = await watchCaptions({
        seconds: args.seconds || 30,
        intervalMs: args.intervalMs || 1200,
        window: args.window,
        top: args.top == null ? 0.82 : args.top,
        bottom: args.bottom == null ? 0.95 : args.bottom,
        keepX: args.keepX == null ? 0.9 : args.keepX,
        scale: args.scale || 3,
      })
      return r
    },
  })

  reg(ctx, {
    name: 'sv_info',
    description: 'Screen size, frame-file accounting and the state of every stream (fps, per-frame cost, buffered frames, events).',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { screen: screenSize(), frameFiles: countFrames(), maxFrameFiles: MAX_FRAME_FILES, streams: [...STREAMS.values()].map(streamInfo) }
    },
  })
}
