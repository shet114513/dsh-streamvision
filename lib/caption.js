
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { capture, encodePng, screenSize, windowRect } from './native.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'data')
const CAPTIONS = path.join(DATA, 'events.jsonl')
const OCR_PS1 = path.join(HERE, 'ocr.ps1')

function ensure() {
  fs.mkdirSync(DATA, { recursive: true })
}

/** 底部字幕带几何：窗口高度的 [top,bottom) 区间，横向取中间 keepX 比例。 */
export function bandRect({ window: title, region, top = 0.82, bottom = 0.95, keepX = 0.9 } = {}) {
  if (region) {
    return { x: region.x | 0, y: region.y | 0, width: region.width | 0, height: region.height | 0 }
  }
  let rx = 0
  let ry = 0
  let rw
  let rh
  if (title) {
    const r = windowRect(title)
    if (r) {
      rx = r.x
      ry = r.y
      rw = r.width
      rh = r.height
    }
  }
  if (!rw || !rh) {
    const s = screenSize()
    rw = s.width
    rh = s.height
    rx = 0
    ry = 0
  }
  const w = Math.max(32, Math.round(rw * keepX))
  const x = Math.round(rx + (rw - w) / 2)
  const h = Math.max(16, Math.round(rh * (bottom - top)))
  const y = Math.round(ry + rh * top)
  return { x, y, width: w, height: h }
}

/** 极简 aHash：缩到 16x8 灰度取均值比较，用来跳过画面没变的帧。 */
export function bandHash(rgb, width, height) {
  const gw = 16
  const gh = 8
  const cells = new Array(gw * gh).fill(0)
  const counts = new Array(gw * gh).fill(0)
  for (let y = 0; y < height; y++) {
    const cy = Math.min(gh - 1, Math.floor((y * gh) / height))
    for (let x = 0; x < width; x++) {
      const cx = Math.min(gw - 1, Math.floor((x * gw) / width))
      const i = (y * width + x) * 3
      const g = (rgb[i] * 299 + rgb[i + 1] * 587 + rgb[i + 2] * 114) / 1000
      const k = cy * gw + cx
      cells[k] += g
      counts[k]++
    }
  }
  let s = ''
  let sum = 0
  for (let k = 0; k < cells.length; k++) {
    cells[k] = cells[k] / Math.max(1, counts[k])
    sum += cells[k]
  }
  const avg = sum / cells.length
  for (let k = 0; k < cells.length; k++) s += cells[k] >= avg ? '1' : '0'
  return s
}

function normalize(text) {
  // Windows OCR 会给汉字之间插空格："近 年 来" -> "近年来"
  return String(text || '')
    .replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 调 Windows 自带 OCR（离线，zh-Hans-CN）。 */
export function ocrImage(filePath, { cropTop = 0.84, cropBottom = 0.94, scale = 3 } = {}) {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-Path', filePath, '-CropTop', String(cropTop), '-CropBottom', String(cropBottom), '-Scale', String(scale)],
    { encoding: 'utf8', timeout: 20000 },
  )
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').slice(-200) }
  try {
    const j = JSON.parse((r.stdout || '').trim().split('\n').pop())
    j.text = normalize(j.text)
    return j
  } catch (e) {
    return { ok: false, error: 'bad-json: ' + String(r.stdout || '').slice(-120) }
  }
}

export function readCaptions({ since = 0, limit = 100 } = {}) {
  let lines = []
  try {
    lines = fs.readFileSync(CAPTIONS, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const out = []
  for (const ln of lines.slice(-2000)) {
    try {
      const e = JSON.parse(ln)
      if ((e.type === 'caption' || e.type === 'caption.final') && e.id > since) out.push(e)
    } catch {
      /* 跳过坏行 */
    }
  }
  return out.slice(-limit)
}

export function clearCaptions() {
  try {
    fs.unlinkSync(CAPTIONS)
  } catch {
    /* 没有就算了 */
  }
}

/**
 * 盯字幕：按 intervalMs 抓字幕带，像素没变就跳过；变了但文本相同也不记。
 * 只有"文本确实变了"才追加一条 caption.final 事件。
 */
export async function watchCaptions({
  seconds = 30,
  intervalMs = 1200,
  window: title,
  region,
  top = 0.82,
  bottom = 0.95,
  keepX = 0.9,
  scale = 3,
  maxNew = 40,
} = {}) {
  ensure()
  const rect = bandRect({ window: title, region, top, bottom, keepX })
  const t0 = Date.now()
  const end = t0 + Math.max(1, Math.min(600, seconds)) * 1000
  const events = []
  let lastHash = ''
  let lastText = ''
  let ocrCalls = 0
  let frames = 0
  let idSeq = (readCaptions({ limit: 1 })[0] || {}).id || 0

  while (Date.now() < end && events.length < maxNew) {
    let shot
    try {
      // 字幕要靠字形，不能像视觉流那样缩到 1/4，这里按原分辨率取
      shot = capture({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, outW: rect.width, outH: rect.height })
    } catch {
      break
    }
    frames++
    const hash = bandHash(shot.rgb, shot.width, shot.height)
    if (hash === lastHash) {
      await new Promise((r) => setTimeout(r, intervalMs))
      continue
    }
    lastHash = hash

    const tmp = path.join(DATA, `cap_${Date.now()}_${frames}.png`)
    fs.writeFileSync(tmp, encodePng({ width: shot.width, height: shot.height, rgb: shot.rgb }))
    const res = ocrImage(tmp, { cropTop: 0, cropBottom: 1, scale })
    ocrCalls++
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }

    if (res && res.ok && res.text && res.text !== lastText) {
      const t = (Date.now() - t0) / 1000
      const ev = {
        id: ++idSeq,
        type: 'caption',
        source: 'ocr',
        text: res.text,
        t_start: Math.round(t * 100) / 100,
        t_end: Math.round((t + intervalMs / 1000) * 100) / 100,
        confidence: null,
      }
      events.push(ev)
      fs.appendFileSync(CAPTIONS, JSON.stringify(ev) + '\n')
      lastText = res.text
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  return {
    ok: true,
    seconds,
    frames,
    ocrCalls,
    rect,
    count: events.length,
    events,
    file: CAPTIONS,
  }
}
