// 文本流：分带 OCR → 稳定判定 → 落盘（data/text.jsonl）
//
// 设计要点（2026-11-18 按主人要求改）：
// - 不再有"字幕框选"（top/bottom/keepX、自动探测全部删掉），固定切三段：上 / 中 / 下。
// - 小字只有 3 倍放大才认得准：上/中（PPT 大字）用 2 倍，下（字幕小字）用 3 倍，三带并发 OCR。
// - 属性不稳定的文本不入流：同一段文字要连续两拍被认到（间隔 ≥ STABLE_MS）才写流；
//   两拍的识别结果允许有抖动（相似度 ≥ 0.85 即视为同一段），落盘时用第一次的版本。
// - 同一 (band, text) 只保留最早一条，之后只更新 lastSeen / hits。
// - 由调用方主动读（sv_text 的 sinceId / wait 长轮询），不往会话里推。

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { capture, encodePng, screenSize, windowRect } from './native.js'
import { normalize } from './caption.js'
import { ocrFile } from './ocr.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'data')
const TEXT = path.join(DATA, 'text.jsonl')
const OCR_PS1 = path.join(HERE, 'ocr.ps1')

/** 三段带（有重叠，避免正好压在分界线的文字被切断）；小字那带放大倍数更高 */
export const BANDS = [
  { name: 'top', lo: 0.0, hi: 0.38, scale: 2 },
  { name: 'mid', lo: 0.32, hi: 0.72, scale: 2 },
  { name: 'bottom', lo: 0.66, hi: 1.0, scale: 3 },
]

export const STABLE_MS = Number(process.env.SV_TEXT_STABLE_MS || 1200)
export const SIMILAR = Number(process.env.SV_TEXT_SIMILAR || 0.85)

function ensure() {
  fs.mkdirSync(DATA, { recursive: true })
}

/** 取窗口（或整屏）矩形；指定了窗口却找不到就报错，绝不静默退回整屏 */
export function frameRect({ window: title, region } = {}) {
  if (region) {
    return { x: region.x | 0, y: region.y | 0, width: region.width | 0, height: region.height | 0 }
  }
  if (title) {
    const r = windowRect(title)
    if (r && r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height }
    throw new Error('window not found: ' + title)
  }
  const s = screenSize()
  return { x: 0, y: 0, width: s.width, height: s.height }
}

export function textKey(text) {
  return String(text || '').replace(/\s+/g, '')
}

/** 两个字符串的 bigram Jaccard 相似度（容忍 OCR 抖动） */
export function similar(a, b) {
  const A = textKey(a)
  const B = textKey(b)
  if (!A || !B) return 0
  if (A === B) return 1
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ga = grams(A)
  const gb = grams(B)
  let inter = 0
  let uni = 0
  for (const [g, n] of ga) {
    const m = gb.get(g) || 0
    inter += Math.min(n, m)
    uni += Math.max(n, m)
  }
  for (const [g, n] of gb) if (!ga.has(g)) uni += n
  return uni ? inter / uni : 0
}

/** 过滤掉太短/纯符号的行 */

// UI 噪声：播放器进度/时间码/网址/清晰度标签不是内容，进流只会污染笔记
const NOISE = [
  /^\d{1,2}\s*[:：]\s*\d{2}(\s*[:：]\s*\d{2})?(\s*\/\s*\d{1,2}\s*[:：]\s*\d{2}(\s*[:：]\s*\d{2})?)?$/,
  /^\d{1,3}\s*[xX×]$/,
  /^(HD|SD|FHD|4K|UHD|1080P|720P)$/i,
  /(yuketang|www\.|https?:\/\/|退出全[屏莫]|按 Esc)/i,
  /^[\s\d,.:：/|×xX-]+$/,
]

function useful(text) {
  const t = normalize(text)
  if (!t) return ''
  const lines = t
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.replace(/[^\p{L}\p{N}]/gu, '').length >= 2)
    .filter((x) => !NOISE.some((re) => re.test(x)))
  return lines.join('\n')
}

/** 异步 OCR：走可插拔接口 lib/ocr.js（默认 WinRT；data/ocr.json 可挂自定义引擎，失败自动回退） */
function ocrAsync(file, { scale = 3 } = {}) {
  return ocrFile(file, { scale, top: 0, bottom: 1 }).then((r) => ({
    ...r,
    text: normalize(r.text || ''),
  }))
}

function cropRgb(shot, { x, y, width, height }) {
  const { width: W, rgb } = shot
  const out = Buffer.alloc(width * height * 3)
  for (let r = 0; r < height; r++) {
    const src = (y + r) * W * 3 + x * 3
    rgb.copy(out, r * width * 3, src, src + width * 3)
  }
  return { width, height, rgb: out }
}

/**
 * 扫一遍所有带（并发 OCR）。返回 { ok, rect, bands:[{band,y,text,chars}] }
 */
export async function scanText({ window: title, region, scale = null } = {}) {
  const rect = frameRect({ window: title, region })
  const shot = capture({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, outW: rect.width, outH: rect.height })
  const jobs = BANDS.map(async (b) => {
    const y0 = Math.round(shot.height * b.lo)
    const h = Math.max(8, Math.round(shot.height * (b.hi - b.lo)))
    const slice = cropRgb(shot, { x: 0, y: y0, width: shot.width, height: h })
    const tmp = path.join(DATA, `txt_${process.pid}_${Date.now()}_${b.name}.png`)
    fs.writeFileSync(tmp, encodePng({ width: slice.width, height: slice.height, rgb: slice.rgb }))
    const res = await ocrAsync(tmp, { scale: scale || b.scale })
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    if (!res || !res.ok) return null
    const text = useful(res.text)
    if (!text) return null
    return { band: b.name, y: y0, text, chars: text.length }
  })
  const bands = (await Promise.all(jobs)).filter(Boolean)
  return { ok: true, rect, bands }
}

/** 整屏 OCR 一次（大变化兜底用；scale 2 已知会掉字，只当兜底） */
export async function scanFull({ window: title, region, scale = 2 } = {}) {
  const rect = frameRect({ window: title, region })
  const shot = capture({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, outW: rect.width, outH: rect.height })
  const tmp = path.join(DATA, `txt_full_${process.pid}_${Date.now()}.png`)
  fs.writeFileSync(tmp, encodePng({ width: shot.width, height: shot.height, rgb: shot.rgb }))
  const res = await ocrAsync(tmp, { scale })
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* ignore */
  }
  if (!res || !res.ok) return { ok: false, rect, bands: [] }
  const text = useful(res.text)
  return { ok: true, rect, bands: text ? [{ band: 'full', y: 0, text, chars: text.length }] : [] }
}

export function readTextAll() {
  let lines = []
  try {
    lines = fs.readFileSync(TEXT, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const out = []
  for (const ln of lines.slice(-2000)) {
    try {
      out.push(JSON.parse(ln))
    } catch {
      /* 跳过坏行 */
    }
  }
  return out
}

export function lastTextId() {
  const all = readTextAll()
  return all.length ? all[all.length - 1].id || 0 : 0
}

// ── 稳定判定状态 ──
// pending: band -> {text, firstSeen}   第一次被认到的版本
// index:   "band|textKey" -> event     已入流的条目
const pending = new Map()
let index = null
let idSeq = 0

function loadIndex() {
  if (index) return
  index = new Map()
  for (const e of readTextAll()) {
    index.set(e.band + '|' + textKey(e.text), e)
    idSeq = Math.max(idSeq, e.id || 0)
  }
}

/**
 * 并入一次扫描结果：同带内与 pending 相似度 ≥ SIMILAR 视为"同一段文字还在"，
 * 隔 ≥ STABLE_MS 后再认到就写流（用 pending 里第一次的版本）。
 */
export function ingestText(scan, { now = Date.now() } = {}) {
  ensure()
  loadIndex()
  const written = []
  const seen = new Set()
  for (const b of scan.bands || []) {
    seen.add(b.band)
    const p = pending.get(b.band)
    if (p && similar(p.text, b.text) >= SIMILAR) {
      if (now - p.firstSeen >= STABLE_MS) {
        const key = b.band + '|' + textKey(p.text)
        const existing = index.get(key)
        if (existing) {
          existing.lastSeen = now
          existing.hits = (existing.hits || 1) + 1
        } else {
          const ev = {
            id: ++idSeq,
            ts: new Date(p.firstSeen).toISOString(),
            band: b.band,
            y: b.y,
            text: p.text,
            chars: p.text.length,
            stableMs: now - p.firstSeen,
            lastSeen: now,
            hits: 2,
          }
          index.set(key, ev)
          written.push(ev)
        }
        // 入流后把 pending 的"起点"推到本次，避免同一段文字被反复判成新条目
        pending.set(b.band, { text: p.text, firstSeen: now })
      }
    } else {
      pending.set(b.band, { text: b.text, firstSeen: now })
    }
  }
  for (const k of [...pending.keys()]) if (!seen.has(k)) pending.delete(k)
  if (written.length) fs.appendFileSync(TEXT, written.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return written
}

/**
 * 主动读：默认回 sinceId 之后的新条目；wait>0 时在同一回合里长轮询。
 */
export async function readText({ sinceId = 0, limit = 20, wait = 0, band = null, maxChars = 4000 } = {}) {
  const deadline = Date.now() + Math.max(0, Math.min(180, wait)) * 1000
  let waited = 0
  for (;;) {
    const all = readTextAll().filter((e) => (e.id || 0) > sinceId && (!band || e.band === band))
    if (all.length) {
      const picked = []
      let used = 0
      for (const e of all) {
        if (picked.length >= limit) break
        const c = (e.text || '').length + 120
        if (used + c > maxChars && picked.length) break
        picked.push(e)
        used += c
      }
      return {
        ok: true,
        count: picked.length,
        total: all.length,
        lastId: picked.length ? picked[picked.length - 1].id : sinceId,
        truncated: picked.length < all.length,
        waitedSec: Math.round(waited * 10) / 10,
        events: picked,
        file: TEXT,
      }
    }
    if (Date.now() >= deadline) {
      return { ok: true, count: 0, total: 0, lastId: sinceId, truncated: false, waitedSec: Math.round(waited * 10) / 10, timedOut: true, events: [], file: TEXT }
    }
    const step = Math.min(400, Math.max(50, deadline - Date.now()))
    const t = Date.now()
    await new Promise((r) => setTimeout(r, step))
    waited += (Date.now() - t) / 1000
  }
}

export function pruneText(maxLines = 4000) {
  try {
    const lines = fs.readFileSync(TEXT, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= maxLines) return 0
    const keep = lines.slice(-maxLines)
    fs.writeFileSync(TEXT, keep.join('\n') + '\n')
    index = null
    return lines.length - keep.length
  } catch {
    return 0
  }
}
