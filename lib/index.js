// Tool registration for the host (sv_* tools).
// 主路径（像素从不进上下文）：
//   采样 sampleStep()  → 每帧同时落一对带时间戳的文件：data/samples/s_<ts>.png + data/vectors/s_<ts>.svg(.json)，按时间保留最近 3 分钟（SV_KEEP_MS 可调，硬上限 3000 份）
//   SVG 转化 writeSample() → 色块量化的矢量对象 + 关系（vector.js）
//   事件转写 eventize()   → 强度 / 哪里变了 / 当前画面 / 上一个事件
//   注入信息            → sv_arm 只写 data/events.jsonl，回合内用 sv_events({wait}) 长轮询读，不唤醒会话
// 字幕那条并行链路（caption.js）走独立的采样→文字处理，与本文件互不干预。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { capture, diffBlocks, encodePng, screenSize, windowRect } from './native.js'
import { createScorer } from './score.js'
import { sampleStep, latestSample, eventize } from './pipeline.js'
import { ingestText, lastTextId, pruneText, readText, scanFull, scanText } from './text.js'

export const name = 'dsh-streamvision'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'data')
// 事件 id 的高水位线：clear 之后不归零，避免客户端旧 sinceId 永久漏读
const SEQ_FILE = path.join(DATA, 'events.seq')
const FRAMES = path.join(DATA, 'frames')
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

// ---- 常驻订阅（sv_arm）：进程内采帧 + 直接投递到当前会话，idleExit 秒没有事件就自己收工 ----
const ARM_STATE = path.join(DATA, 'arm.json')

function readArm() {
  try {
    return JSON.parse(fs.readFileSync(ARM_STATE, 'utf8'))
  } catch {
    return null
  }
}

function writeArm(v) {
  fs.mkdirSync(DATA, { recursive: true })
  if (v) fs.writeFileSync(ARM_STATE, JSON.stringify(v, null, 1))
  else {
    try {
      fs.unlinkSync(ARM_STATE)
    } catch {
      /* ignore */
    }
  }
}

function regionOf(region) {
  if (!region) return {}
  const { x, y, width, height } = region
  return { x: x | 0, y: y | 0, width: width | 0 || undefined, height: height | 0 || undefined }
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
    // 明确要求某个窗口时，找不到就报错——静默退回整屏会抓到别的窗口，比失败更糟
    if (!r) throw new Error(`window not found: ${args.window}`)
    g = { x: r.x, y: r.y, width: r.width, height: r.height, followed: args.window }
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
  void ctx

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
    description: 'Capture one frame right now and save it as PNG; returns the file path. Use it to look at the current picture between watches.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title fragment to capture; omit = whole screen.' },
        region: {
          type: 'object',
          description: 'Capture only this region: {x,y,width,height}.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        preset: { type: 'string', enum: ['bottom', 'dialogue'], description: 'bottom = the bottom 24% band of the window (subtitle / caption area).' },
        path: { type: 'string', description: 'Custom output path.' },
        maxHeight: { type: 'number', description: 'Quality for a fresh capture (max frame height, default 720).' },
        outW: { type: 'number', description: 'Width for a fresh capture (defaults to maxHeight 720).' },
      },
    },
    async execute(args = {}) {
      const f = capture({ ...geo(args), outW: args.outW, maxHeight: args.maxHeight || 720 })
      const p = args.path ? path.resolve(args.path) : path.join(FRAMES, `sv_snap_${Date.now()}.png`)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, encodePng(f))
      pruneFrames()
      return { path: p, size: [f.width, f.height] }
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
            if (peaks.length > 100) {
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
        wait: {
          type: 'number',
          description:
            'Long-poll: block up to this many seconds waiting for a new event (max 120, default 0 = return immediately). ' +
            'Returns the moment something new lands, so you can keep reading the stream inside ONE turn instead of being woken up per event.',
        },
        clear: { type: 'boolean', description: 'Truncate the queue after reading (default false).' },
      },
    },
    async execute(args = {}) {
      const file = path.join(DATA, 'events.jsonl')
      const readRows = () => {
        try {
          return fs
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
          return []
        }
      }
      let since = Number(args.sinceId || 0)
      // 按 id 升序（历史文件里 id 可能乱序，不能假设追加顺序就是 id 顺序）
      const pick = (rows) => (since ? rows.filter((r) => Number(r.id || 0) > since) : rows).slice().sort((a, b) => Number(a.id || 0) - Number(b.id || 0))

      let rows = readRows()
      // 自动纠正：sinceId 超过当前最大 id（队列被清过 / id 归零过）时按 0 处理并告知，
      // 免得客户端拿着旧 sinceId 永久读不到东西（0.2.2 被反馈的第三个 bug）
      const maxIdNow = rows.reduce((m, r) => Math.max(m, Number(r.id || 0)), 0)
      const clamped = since > maxIdNow
      if (clamped) {
        since = 0
      }
      let pool = pick(rows)
      const waitSec = Math.max(0, Math.min(120, Number(args.wait || 0)))
      let waitedSec = 0
      if (waitSec > 0 && pool.length === 0) {
        const t0 = Date.now()
        const deadline = t0 + waitSec * 1000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          rows = readRows()
          pool = pick(rows)
          if (pool.length) break
        }
        waitedSec = Math.round((Date.now() - t0) / 100) / 10
      }

      // 增量读必须从“最早未读”开始：老版本这里用 slice(-limit) 取最后 N 条，
      // 一旦待读事件多于 limit（比如 20 条只取 5 条），中间那些就被静默跳过 —— 正是 0.2.2 被反馈的 bug。
      const limit = Math.max(1, Math.min(30, args.limit || 5))
      const out = pool.slice(0, limit)
      const nextId = out.length ? Number(out[out.length - 1].id || 0) : since
      if (args.clear) {
        try {
          // 先把高水位线落盘，再清文件：之后新事件继续从 maxId+1 开始，不会回到 1
          writeSeq(readMaxId())
          fs.writeFileSync(file, '', 'utf8')
        } catch {
          /* ignore */
        }
      }
      const maxId = readMaxId()
      const res = {
        total: rows.length,
        maxId,
        pending: pool.length,
        truncated: pool.length > out.length,
        nextId,
        returned: out.length,
        cleared: args.clear === true,
        reset: args.clear === true,
        waitedSec,
        timedOut: waitSec > 0 && pool.length === 0,
        events: out,
      }
      if (clamped) {
        res.staleSince = true
        res.clamped = true
        res.note = `sinceId 超过当前最大 id=${maxId}（队列被清过），已按 0 处理：从最早一条给起`
      }
      if (!rows.length && !res.staleSince) {
        if (ARMED.lastError && !ARMED.on) {
          res.note = 'no events: last arm failed — ' + ARMED.lastError
        } else if (ARMED.on) {
          res.note = 'armed but no change recorded yet (static screen or detector too dull; try score:"blocks", threshold:4)'
        } else {
          res.note = 'no events: sv_arm is not running (start it, or read a past session)'
        }
      }
      else if (since) res.lastId = Math.max(...rows.map((r) => Number(r.id || 0)))
      if (res.truncated) res.note = `还有 ${pool.length - out.length} 条未读，用 nextId=${nextId} 继续读`
      return res
    },
  })

  // ── sv_text：文本流（分带 OCR + 稳定判定 + 主动读）──
  reg(ctx, {
    name: 'sv_text',
    description: 'Text stream from the screen (local Windows OCR, offline). No subtitle-band selection: the window is split into top/mid/bottom bands, each OCRed at 3x. A line only enters the stream after being recognised twice at least 1.2s apart (unstable text is dropped); duplicates keep the earliest record and only bump lastSeen. action=scan runs one scan now; action=read long-polls entries with id > sinceId (waits up to `wait` seconds in the same turn); action=prune trims the file.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'scan', 'prune'], description: 'Default read.' },
        sinceId: { type: 'number', description: 'read: only entries with id greater than this.' },
        wait: { type: 'number', description: 'read: long-poll up to this many seconds (max 180); returns as soon as something new lands.' },
        limit: { type: 'number', description: 'read: max entries, default 20.' },
        band: { type: 'string', enum: ['top', 'mid', 'bottom', 'full'], description: 'read: only this band.' },
        maxChars: { type: 'number', description: 'read: character budget per call, default 4000.' },
        window: { type: 'string', description: 'scan: window title fragment; omit to use the whole screen.' },
        scale: { type: 'number', description: 'scan: upscale before OCR, default 3.' },
        full: { type: 'boolean', description: 'scan: also OCR the whole frame at 2x as a fallback.' },
        maxLines: { type: 'number', description: 'prune: keep the newest N lines, default 4000.' },
      },
    },
    async execute(args = {}) {
      const action = args.action || 'read'
      if (action === 'prune') return { ok: true, removed: pruneText(args.maxLines || 4000) }
      if (action === 'scan') {
        const scan = args.full ? await scanFull({ window: args.window, scale: 2 }) : await scanText({ window: args.window, scale: args.scale || null })
        const written = ingestText(scan)
        return {
          ok: true,
          rect: scan.rect,
          bands: (scan.bands || []).map((b) => ({ band: b.band, chars: b.chars })),
          written: written.length,
          events: written,
          lastId: lastTextId(),
        }
      }
      return readText({
        sinceId: args.sinceId || 0,
        limit: Math.max(1, Math.min(200, args.limit || 20)),
        wait: args.wait || 0,
        band: args.band || null,
        maxChars: args.maxChars || 4000,
      })
    },
  })

  // ── sv_arm：常驻变化订阅（完全自包含，只往 events.jsonl 写，不往会话投递）──
  // 开的时候按 fps 采帧做块差分，一有事件就追加一行；模型用 sv_events({wait}) 长轮询读，
  // 全程在同一个回合里，不靠"被唤醒"重读上下文。idleExit 秒无事件或 action=off 就自己收工。
  const ARMED = {
    on: false,
    seq: 0,
    startedAt: 0,
    lastEventAt: 0,
    lastEmit: 0,
    emits: 0,
    minuteMark: 0,
    minuteCount: 0,
    timer: null,
    cfg: null,
    lastVia: 'events.jsonl',
    lastError: '',
    failStreak: 0,
    writeFail: 0,
    stopReason: '',
  }

  const armStop = (reason) => {
    if (ARMED.timer) clearInterval(ARMED.timer)
    ARMED.timer = null
    ARMED.on = false
    ARMED.stopReason = reason
    writeArm(null)
  }

  // 高水位线读写：events.jsonl 可能被 sv_events{clear} 清空，但 id 不能回到 1
  const readSeq = () => {
    try {
      return Number(fs.readFileSync(SEQ_FILE, 'utf8').trim()) || 0
    } catch {
      return 0
    }
  }
  const writeSeq = (n) => {
    try {
      fs.mkdirSync(DATA, { recursive: true })
      fs.writeFileSync(SEQ_FILE, String(n), 'utf8')
    } catch {
      /* ignore */
    }
  }
  const readFileMaxId = () => {
    try {
      const file = path.join(DATA, 'events.jsonl')
      const rows = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
      return rows.reduce((m, l) => {
        try {
          const r = JSON.parse(l)
          return Math.max(m, Number(r.id || 0))
        } catch {
          return m
        }
      }, 0)
    } catch {
      return 0
    }
  }
  const readMaxId = () => Math.max(readFileMaxId(), readSeq())

  const armStart = (args) => {
    const cfg = {
      window: args.window || '',
      fps: Math.max(1, Math.min(10, args.fps || 4)),
      maxHeight: Math.max(240, Math.min(1080, args.maxHeight || 480)),
      idleExit: Math.max(10, args.idleExit || 60),
      maxMinutes: Math.max(1, args.maxMinutes || 30),
      threshold: Math.max(1, args.threshold || 6),
      score: args.score === 'blocks' ? 'blocks' : 'hsv',
      cutAbs: Math.max(0.5, Number(args.cutAbs) || 12),
      // 局部判据：最活跃的 8×6 小块均值越过它也算变化。整帧平均会把"只变了一行"的界面稀释成 0.3–0.7，
      // 默认 12 与全帧阈值对齐；静态界面/聊天/文档场景建议 8–12，噪声大的视频可抬到 18–20。
      localCut: Math.max(0.5, Number(args.localCut) || 12),
      // 面积判据：差得明显的像素占比。文档/聊天里改一行约 0.4%–1%，静态噪声通常 <0.1%，整屏动画几十个百分点。
      areaCut: Math.max(0.0005, Number(args.areaCut) || 0.004),
      cooldownMs: Math.max(500, args.cooldownMs || 1500),
      maxPerMin: Math.max(1, Math.min(30, args.maxPerMin || 6)),
    }
    if (cfg.window && !windowRect(cfg.window)) return { status: 'error', error: `window not found: ${cfg.window}` }
    if (ARMED.timer) clearInterval(ARMED.timer)
    Object.assign(ARMED, {
      on: true,
      stopReason: '',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      lastEmit: 0,
      emits: 0,
      minuteMark: Date.now(),
      minuteCount: 0,
      cfg,
      lastVia: 'events.jsonl',
      lastError: '',
      failStreak: 0,
      writeFail: 0,
      seq: readMaxId(),
    })

    let prev = null
    let armLast = null
    const scorer = createScorer()
    const interval = Math.max(100, Math.round(1000 / cfg.fps))
    const t0 = Date.now()
    ARMED.timer = setInterval(() => {
      const now = Date.now()
      if (now - ARMED.startedAt > cfg.maxMinutes * 60000) return armStop('maxMinutes')
      if (now - ARMED.lastEventAt > cfg.idleExit * 1000) return armStop('idle')
      if (now - ARMED.minuteMark >= 60000) {
        ARMED.minuteMark = now
        ARMED.minuteCount = 0
      }
      // 采样（顺带落 PNG + SVG，两份都带时间戳、各留 100 份）
      let sample
      try {
        const r = cfg.window ? windowRect(cfg.window) : null
        const region = r ? { x: r.x, y: r.y, width: r.width, height: r.height } : {}
        sample = sampleStep({ region, maxHeight: cfg.maxHeight, gw: 32, gh: 18, now })
        ARMED.failStreak = 0
      } catch (e) {
        // 不静默：记下最近一次异常并计数，连续 10 次自动收工（避免 armed:true 却什么都发生不了的"假活"）
        ARMED.lastError = 'sampleStep: ' + ((e && (e.message || e.code)) || String(e))
        ARMED.failStreak = (ARMED.failStreak || 0) + 1
        if (ARMED.failStreak >= 10) return armStop('error')
        return
      }
      const frame = sample.frame
      const d = prev ? diffBlocks(prev, frame) : { mean: 0, peak: 0, blocks: [] }
      prev = frame
      // 判据：默认用 see-now 口径的 HSV 打分（0–255，含暗画面亮度归一），
      // 想退回旧的"块差分均值 + 阈值"就传 score:'blocks'。
      let hit = false
      let rawScore = 0
      let scoreVal = 0
      let localScore = 0
      let areaScore = 0
      if (cfg.score === 'blocks') {
        hit = d.mean >= cfg.threshold || d.peak >= cfg.threshold * 4
        rawScore = d.mean
        scoreVal = d.mean
      } else {
        const sr = scorer(frame.rgb, frame.width, frame.height)
        rawScore = sr.raw
        scoreVal = sr.score
        localScore = sr.local || 0
        areaScore = sr.area || 0
        hit = sr.score >= cfg.cutAbs || localScore >= cfg.localCut || areaScore >= cfg.areaCut
      }
      if (!hit) return
      if (now - ARMED.lastEmit < cfg.cooldownMs) return
      if (ARMED.minuteCount >= cfg.maxPerMin) return
      ARMED.lastEmit = now
      ARMED.lastEventAt = now
      ARMED.minuteCount++
      ARMED.emits++
      // 采样时已经把这一帧转成 SVG 了，这里只做"转写成事件"：描述 + 强度 + 与上一事件的关系
      const ev = eventize({ frame, vector: sample.vector, diff: d, prevEvent: armLast, mean: rawScore, peak: d.peak })
      const rec = {
        id: ++ARMED.seq,
        type: 'motion',
        t: +((now - t0) / 1000).toFixed(1),
        at: new Date(now).toISOString(),
        strength: ev.strength,
        mean: +Number(rawScore || 0).toFixed(1),
        score: +Number(scoreVal || 0).toFixed(1),
        local: +Number(localScore || 0).toFixed(1),
        area: +(Number(areaScore || 0) * 100).toFixed(2),
        peak: +d.peak.toFixed(1),
        blocks: d.blocks.slice(0, 3).map((b) => ({ x: b.x, y: b.y, v: +b.v.toFixed(1) })),
        scene: ev.scene,
        where: ev.where,
        objects: ev.objects,
        svg: ev.svg,
        svgChars: sample.svgChars,
        prev: ev.prev,
        window: cfg.window,
        sample: { png: sample.png, svg: sample.svg, ts: sample.ts },
      }
      armLast = { t: rec.t, strength: rec.strength, scene: rec.scene, where: rec.where }
      try {
        fs.appendFileSync(path.join(DATA, 'events.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
      } catch {
        /* 落盘失败就丢掉这一条，下一拍再记 */
      }
      // 大变化兜底：整片翻动时顺手整屏 OCR 一次（scale 2 慢，所以只在 strong 且 20 秒冷却外触发），
      // 结果并入文本流，避免"只有局部变了、文字在别处"漏掉。
      if (cfg.textFull !== false && rec.strength === 'strong') {
        const lastFull = ARMED.lastFullOcr || 0
        if (now - lastFull >= (cfg.fullOcrMs || 20000)) {
          ARMED.lastFullOcr = now
          scanFull({ window: cfg.window, scale: 2 })
            .then((r) => ingestText(r))
            .catch(() => {})
        }
      }
    }, interval)

    writeArm({ startedAt: ARMED.startedAt, ...cfg })
    return { armed: true, ...cfg, feed: 'data/events.jsonl', note: `auto-off after ${cfg.idleExit}s idle; hard cap ${cfg.maxMinutes}min; read with sv_events({wait})` }
  }

  reg(ctx, {
    name: 'sv_arm',
    description:
      'Always-on change feed (self-contained; no other plugin involved, and it never pushes messages into the conversation). action=on starts ' +
      'an in-process watcher: every tick samples the screen and writes a timestamped pair (PNG + SVG conversion, latest 100 each) first, ' +
      'then appends one compact event per meaningful screen change to data/events.jsonl; you read them with ' +
      'sv_events({wait}) — a long-poll that returns the instant something lands, so you can keep watching inside ONE turn instead of being ' +
      'woken up per event. Disarms itself after `idleExit` seconds with no event (default 60) or after `maxMinutes` (default 30). ' +
      'action=status reports armed state, idle seconds and emit count.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['on', 'off', 'status'], description: 'Default status.' },
        window: { type: 'string', description: 'on: window title fragment to follow; omit = whole screen.' },
        fps: { type: 'number', description: 'on: sampling fps, default 4 (max 10).' },
        maxHeight: { type: 'number', description: 'on: frame height for diffing, default 480.' },
        threshold: { type: 'number', description: 'on: only for score:"blocks" — mean block difference that counts as an event, default 6.' },
        score: { type: 'string', enum: ['hsv', 'blocks'], description: 'on: change criterion. "hsv" (default) = see-now style HSV score on a 64x36 grid with brightness gain; "blocks" = legacy block-diff mean.' },
        cutAbs: { type: 'number', description: 'on: HSV mode threshold on the whole-frame 0-255 score, default 12 (see-now cutAbs).' },
        localCut: { type: 'number', description: 'on: HSV mode threshold on the busiest 8x6 block (0-255), default 12.' },
        areaCut: { type: 'number', description: 'on: fraction of pixels (0-1) that must change noticeably, default 0.004 (=0.4%). This is what keeps chat/document edits from being averaged away; set 0.02-0.05 for noisy video, 0.001 for very small UI elements.' },
        cooldownMs: { type: 'number', description: 'on: minimum gap between two delivered events, default 1500.' },
        maxPerMin: { type: 'number', description: 'on: cap on delivered events per minute, default 6.' },
        idleExit: { type: 'number', description: 'on: auto-disarm after this many seconds with no event, default 60.' },
        maxMinutes: { type: 'number', description: 'on: hard cap in minutes, default 30.' },
      },
    },
    async execute(args = {}) {
      const action = args.action || 'status'
      if (action === 'off') {
        const was = ARMED.on
        armStop('manual')
        return { armed: false, wasArmed: was }
      }
      if (action === 'status') {
        const saved = readArm()
        return {
          armed: ARMED.on,
          stopReason: ARMED.stopReason || null,
          startedAt: ARMED.on ? new Date(ARMED.startedAt).toISOString() : null,
          secondsArmed: ARMED.on ? Math.round((Date.now() - ARMED.startedAt) / 1000) : 0,
          idleSeconds: ARMED.on ? Math.round((Date.now() - ARMED.lastEventAt) / 1000) : 0,
          emits: ARMED.emits,
          feed: 'data/events.jsonl',
          deliverVia: ARMED.lastVia || null,
          lastError: ARMED.lastError || null,
          cfg: ARMED.cfg,
          lastRunFile: saved,
        }
      }
      return armStart(args)
    },
  })

  reg(ctx, {
    name: 'sv_blocks',
    description:
      'Read the newest SVG conversion produced by the sampling stage (sampling → SVG conversion → event writing). ' +
      'Every sample writes two timestamped files at once — the raw PNG (data/samples) and its vector conversion (data/vectors, .svg + .json) — ' +
      'keeping the last 3 minutes by age (SV_KEEP_MS, default 180000; hard cap 3000). Default mode returns the newest conversion without touching the screen; mode:"live" takes one more sample first. ' +
      'Nothing enters the conversation except numbers/paths, so this is the cheap way to ask "what is on screen".',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['latest', 'live'], description: 'latest (default) = newest conversion on disk; live = sample now, then convert.' },
        window: { type: 'string', description: 'live only: window title fragment; omit = whole screen.' },
        region: {
          type: 'object',
          description: 'live only: sample only this region {x,y,width,height}.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        },
        maxHeight: { type: 'number', description: 'live only: capture height, default 480.' },
        withSvg: { type: 'boolean', description: 'Include the SVG markup itself (default true).' },
      },
    },
    async execute(args = {}) {
      let info = args.mode === 'live' ? (() => { const s = sampleStep({ ...geo(args), maxHeight: args.maxHeight || 480, gw: 32, gh: 18 }); return latestSample() || { ts: s.ts } })() : latestSample()
      if (!info) return { status: 'empty', hint: 'no samples yet — run sv_frame / sv_watch / sv_arm once, or call with mode:"live"' }
      const { svg, ...rest } = info
      return { ...rest, svg: args.withSvg === false ? undefined : svg }
    },
  })

  reg(ctx, {
    name: 'sv_info',
    description: 'Screen size, frame-file accounting and the armed-subscription state (armed, emits, idle seconds, last error).',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return {
        screen: screenSize(),
        frameFiles: countFrames(),
        maxFrameFiles: MAX_FRAME_FILES,
        arm: {
          armed: ARMED.on,
          emits: ARMED.emits,
          idleSeconds: ARMED.on ? Math.round((Date.now() - ARMED.lastEventAt) / 1000) : 0,
          stopReason: ARMED.stopReason || null,
          lastError: ARMED.lastError || null,
          failStreak: ARMED.failStreak || 0,
        },
      }
    },
  })
}
