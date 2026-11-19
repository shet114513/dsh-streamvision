// 管线：采样 → SVG 转化 → 事件转写 → 注入信息。
// 采样阶段每来一帧就同时落两张文件（原图 PNG + 转化 SVG），都带时间戳、各留最近 N 份；
// 事件阶段只拿"当前 + 上一个"结构化结果，不碰像素。字幕那条并行链路（caption.js）与本文件无关。

import fs from 'node:fs'
import path from 'node:path'
import { capture, diffBlocks, encodePng } from './native.js'
import { toVector, rgb2hsl, colorName } from './vector.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const DATA = path.join(ROOT, 'data')
const SAMPLES = path.join(DATA, 'samples') // 原图 PNG
const VECTORS = path.join(DATA, 'vectors') // 转化 SVG
const KEEP_MS = Number(process.env.SV_KEEP_MS || 180000) // 采样池按时间保留：默认 3 分钟
const KEEP_MAX = Number(process.env.SV_KEEP_SAMPLES || 3000) // 硬上限，防 4fps 时无限堆

const pad = (v, n = 2) => String(v).padStart(n, '0')
export function stamp(d = new Date()) {
  return (
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + pad(d.getMilliseconds(), 3)
  )
}

/** 按时间清理：同时间戳的 png/svg/json 算一份；超过 keepMs 的删掉，多于 keepMax 份的从最旧删 */
export function prune(dir, { keepMs = KEEP_MS, keepMax = KEEP_MAX, now = Date.now() } = {}) {
  try {
    const stems = [...new Set(fs.readdirSync(dir).map((f) => f.replace(/\.[a-z]+$/, '')))].sort()
    const stale = stems.filter((stem) => {
      let t = NaN
      try { t = fs.statSync(path.join(dir, stem + '.png')).mtimeMs } catch { /* 没有 png 就按名字解析 */ }
      if (Number.isNaN(t)) {
        const m = stem.match(/^s_(\d{8})-(\d{6})-(\d{3})$/)
        if (m) t = new Date(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6), +m[3]).getTime()
      }
      return !Number.isNaN(t) && now - t > keepMs
    })
    const alive = stems.filter((s) => !stale.includes(s))
    const over = alive.length > keepMax ? alive.slice(0, alive.length - keepMax) : []
    for (const stem of [...stale, ...over]) {
      for (const ext of ['.png', '.svg', '.json']) {
        try { fs.unlinkSync(path.join(dir, stem + ext)) } catch { /* 不存在或被占用 */ }
      }
    }
  } catch { /* 目录还没建 */ }
}

/** 把已采到的一帧落成一对带时间戳的文件（PNG + SVG + JSON），各留最近 keep 份 */
export function writeSample(frame, { gw = 32, gh = 18, now = Date.now() } = {}) {
  fs.mkdirSync(SAMPLES, { recursive: true })
  fs.mkdirSync(VECTORS, { recursive: true })
  const ts = stamp(new Date(now))
  const png = path.join(SAMPLES, `s_${ts}.png`)
  const svgFile = path.join(VECTORS, `s_${ts}.svg`)
  const vector = toVector(frame, { gw, gh, maxObjects: 8 })
  fs.writeFileSync(png, encodePng(frame))
  fs.writeFileSync(svgFile, vector.svg, 'utf8')
  // 结构化副本：读的时候不用再解析 SVG
  fs.writeFileSync(svgFile.replace(/\.svg$/, '.json'), JSON.stringify({
    ts, capture: [frame.width, frame.height], palette: vector.palette,
    objects: vector.objects.map(({ path, ...rest }) => rest),
    relations: vector.relations, stats: vector.stats, svgChars: vector.svg.length,
  }), 'utf8')
  prune(SAMPLES)
  prune(VECTORS)
  return { frame, vector, png, svg: svgFile, ts, svgChars: vector.svg.length }
}

/** 采样 → 落盘（PNG + SVG）→ 返回结构化结果 */
export function sampleStep({ window: win = '', region = {}, maxHeight = 480, gw = 32, gh = 18, now = Date.now() } = {}) {
  const frame = capture({ ...region, maxHeight })
  return { ...writeSample(frame, { gw, gh, now }), window: win }
}

/** 最近一次转化结果（不重新采样） */
export function latestSample() {
  try {
    const files = fs.readdirSync(VECTORS).filter((f) => f.endsWith('.svg')).sort()
    if (!files.length) return null
    const f = files[files.length - 1]
    const ts = f.replace(/^s_|\.svg$/g, '')
    const svgPath = path.join(VECTORS, f)
    const jsonPath = svgPath.replace(/\.svg$/, '.json')
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) } catch { meta = null }
    return {
      ts,
      png: path.join(SAMPLES, `s_${ts}.png`),
      svgFile: svgPath,
      jsonFile: jsonPath,
      svg: fs.readFileSync(svgPath, 'utf8'),
      ...(meta || {}),
    }
  } catch {
    return null
  }
}

/** 网格坐标 → 百分比位置 + 该点颜色，用来回答"哪里变了" */
export function whereText(img, blocks, max = 3) {
  if (!img || !blocks || !blocks.length) return ''
  return blocks.slice(0, max).map((b) => {
    const x = Math.min(Math.max(Math.round(b.x), 0), img.width - 1)
    const y = Math.min(Math.max(Math.round(b.y), 0), img.height - 1)
    const i = (y * img.width + x) * 3
    const { h, s, l } = rgb2hsl(img.rgb[i], img.rgb[i + 1], img.rgb[i + 2])
    return `${Math.round((b.x / img.width) * 100)}%,${Math.round((b.y / img.height) * 100)}% ${colorName(h, s, l)}`
  }).join(' / ')
}

/** 变化强度分档 */
export function strengthOf(mean, peak) {
  const score = mean * 0.6 + peak * 0.4
  if (score >= 55) return 'strong'
  if (score >= 22) return 'medium'
  return 'weak'
}

/** 事件转写：当前帧 + 上一事件 → 一条可直接读的事件 */
export function eventize({ frame, vector, diff, prevEvent = null, mean = 0, peak = 0 }) {
  const objects = (vector?.objects || []).slice(0, 5).map((o) => `${o.color}${o.share}%[${o.norm.join(',')}]`)
  const base = {
    strength: strengthOf(mean, peak),
    scene: objects.slice(0, 4).join(' '),
    where: whereText(frame, diff?.blocks || [], 3),
    objects,
    // 边缘密度（%，相邻格色差 >90 的占比）：盲读用 —— <10 空旷场景 / 10–25 普通 / >25 信息密集界面
    edgeDensity: vector?.stats?.edgeDensity ?? null,
    // 事件里只放完整 SVG；太长就整段省略（给 sample.svg 路径去读文件），避免塞半截 XML
    svg: vector && vector.svg.length <= 2400 ? vector.svg : null,
  }
  return {
    ...base,
    prev: prevEvent ? { t: prevEvent.t, strength: prevEvent.strength, objects: prevEvent.objects } : null,
  }
}

export { diffBlocks }
