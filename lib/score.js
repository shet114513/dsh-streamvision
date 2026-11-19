// 变化判据：把一帧降采样到 SCAN_W×SCAN_H，转 HSV，用 see-now 的口径打分。
//
// 口径来源（SAOS-3624/dsh-see-now 的 src/cuts.js）：
//   scorePair  = 逐像素 |ΔH|*min(S)/255 + |ΔS| + |ΔV| 的平均值（0–255 色阶）
//   brightnessGain = 暗画面放大（REF_V=96，上限 1.85 倍，V<40 不再放大）
//   noiseFloor = 2（低于它不放大，避免把压缩噪声吹大）
// 与 see-now 的差别：不做黑边检测（barFraction）——sv 是"变化事件流"，不是抽关键帧，
// 黑边补偿只会把一条静默的黑画面也放大成事件。这里只保留亮度归一。

export const SCAN_W = 64
export const SCAN_H = 36
export const REF_V = 96
export const GAIN_MAX = 1.85
export const V_FLOOR = 40
export const NOISE_FLOOR = 2

/** 最近邻把 rgb(w*h*3) 采样成 SCAN_W*SCAN_H*3 */
export function toScan(rgb, width, height) {
  const out = new Float32Array(SCAN_W * SCAN_H * 3)
  for (let y = 0; y < SCAN_H; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / SCAN_H))
    for (let x = 0; x < SCAN_W; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / SCAN_W))
      const s = (sy * width + sx) * 3
      const d = (y * SCAN_W + x) * 3
      out[d] = rgb[s]
      out[d + 1] = rgb[s + 1]
      out[d + 2] = rgb[s + 2]
    }
  }
  return out
}

/** RGB(0–255) → HSV，H/S/V 都映射到 0–255 */
export function rgbToHsv(rgb) {
  const out = new Float32Array(rgb.length)
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] / 255
    const g = rgb[i + 1] / 255
    const b = rgb[i + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    let h = 0
    if (d > 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 42.5
      else if (max === g) h = ((b - r) / d + 2) * 42.5
      else h = ((r - g) / d + 4) * 42.5
    }
    out[i] = h
    out[i + 1] = max === 0 ? 0 : (d / max) * 255
    out[i + 2] = max * 255
  }
  return out
}

/** 两帧 HSV 的加权差（0–255） */
export function scorePair(prev, cur) {
  let sum = 0
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i])
    const hueDiff = Math.min(dh, 255 - dh)
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255
    sum += hueDiff * hueWeight + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2])
  }
  return sum / (cur.length / 3) / 3
}

/** 全帧平均亮度 V（只用有效像素的平均即可） */
export function meanV(hsv) {
  let sum = 0
  for (let i = 2; i < hsv.length; i += 3) sum += hsv[i]
  return sum / (hsv.length / 3)
}

/** 暗画面增益：亮的不动，暗的放大，最多 1.85 倍 */
export function brightnessGain(v, { refV = REF_V, gainMax = GAIN_MAX, vFloor = V_FLOOR } = {}) {
  if (!Number.isFinite(v) || v <= 0) return 1
  return Math.min(gainMax, Math.max(1, refV / Math.max(vFloor, v)))
}

/**
 * 带状态的打分器：喂进 rgb + 尺寸，回 { score, raw, gain }。
 * 第一次调用没有前一帧，返回 0。
 */
export function createScorer() {
  let prev = null
  return function score(rgb, width, height) {
    const cur = rgbToHsv(toScan(rgb, width, height))
    let raw = 0
    if (prev) {
      raw = scorePair(prev, cur)
      const gain = raw < NOISE_FLOOR ? 1 : brightnessGain(meanV(cur))
      prev = cur
      return { score: raw < NOISE_FLOOR ? raw : raw * gain, raw, gain }
    }
    prev = cur
    return { score: 0, raw: 0, gain: 1 }
  }
}
