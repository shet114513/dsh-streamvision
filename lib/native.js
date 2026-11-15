
import koffi from 'koffi'
import zlib from 'node:zlib'

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

const GetDC = user32.func('void* GetDC(void* hwnd)')
const ReleaseDC = user32.func('int ReleaseDC(void* hwnd, void* hdc)')
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)')
const CreateCompatibleDC = gdi32.func('void* CreateCompatibleDC(void* hdc)')
const CreateCompatibleBitmap = gdi32.func('void* CreateCompatibleBitmap(void* hdc, int w, int h)')
const SelectObject = gdi32.func('void* SelectObject(void* hdc, void* obj)')
const BitBlt = gdi32.func('int BitBlt(void* dst, int dx, int dy, int w, int h, void* src, int sx, int sy, uint32 rop)')
const GetDIBits = gdi32.func('int GetDIBits(void* hdc, void* bmp, uint32 start, uint32 lines, _Out_ uint8* bits, _Inout_ void* bi, uint32 usage)')
const DeleteObject = gdi32.func('int DeleteObject(void* obj)')
const DeleteDC = gdi32.func('int DeleteDC(void* hdc)')

// per-monitor DPI aware: otherwise coordinates and pixels use two different rulers
try {
  const setDpi = user32.func('int SetProcessDpiAwarenessContext(intptr_t ctx)')
  setDpi(-4)
} catch {
  /* 老系统没有这个 API 就按原样跑 */
}

const FindWindowW = user32.func('void* FindWindowW(str16 cls, str16 title)')
const GetWindowRect = user32.func('int GetWindowRect(void* hwnd, _Out_ int* rect)')
const IsWindowVisible = user32.func('int IsWindowVisible(void* hwnd)')
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void* hwnd)')
const GetWindowTextW = user32.func('int GetWindowTextW(void* hwnd, _Out_ uint16* buf, int n)')
const EnumWindows = user32.func('int EnumWindows(void* cb, intptr_t lParam)')
const ENUMPROC = koffi.proto('int __stdcall EnumProc(void* hwnd, intptr_t lParam)')

const SRCCOPY = 0x00cc0020

/** 按标题片段找第一个可见窗口（浏览器标题常带后缀，精确匹配会落空）。 */
export function findWindow(fragment) {
  if (!fragment) return null
  const want = String(fragment)
  let found = null
  const proc = koffi.register((hwnd) => {
    if (found) return 0
    if (!IsWindowVisible(hwnd)) return 1
    const len = GetWindowTextLengthW(hwnd)
    if (len <= 0) return 1
    const buf = Buffer.alloc((len + 1) * 2)
    const n = GetWindowTextW(hwnd, buf, len + 1)
    const title = buf.subarray(0, n * 2).toString('utf16le').trim()
    if (title && title.includes(want)) {
      found = hwnd
      return 0
    }
    return 1
  }, koffi.pointer(ENUMPROC))
  try {
    EnumWindows(proc, 0)
  } finally {
    koffi.unregister(proc)
  }
  return found
}

// 按窗口标题找矩形（进程内 DPI 已感知，拿到的是物理像素）。
// 找不到或最小化时返回 null——调用方要退回整屏，别静默拍一块黑。
export function windowRect(title) {
  if (!title) return null
  let hwnd = FindWindowW(null, title)
  if (!hwnd) {
    // 精确标题找不到就按片段匹配（浏览器标题通常是 "网课 - 夸克" 这种）
    hwnd = findWindow(title)
  }
  if (!hwnd) return null
  const buf = Buffer.alloc(16) // RECT: 4 个 int32
  if (!GetWindowRect(hwnd, buf)) return null
  const left = buf.readInt32LE(0)
  const top = buf.readInt32LE(4)
  const right = buf.readInt32LE(8)
  const bottom = buf.readInt32LE(12)
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return null
  if (left <= -30000 || top <= -30000) return null // 最小化
  return { x: left, y: top, width, height, hwnd: Number(hwnd) }
}

const HEADER_SIZE = 40
function makeBitmapInfo(w, h) {
  const bi = Buffer.alloc(HEADER_SIZE + 16)
  bi.writeUInt32LE(HEADER_SIZE, 0)
  bi.writeInt32LE(w, 4)
  bi.writeInt32LE(h, 8) // 正数 = 自下而上
  bi.writeUInt16LE(1, 12)
  bi.writeUInt16LE(32, 14)
  bi.writeUInt32LE(0, 16) // BI_RGB
  return bi
}

export function screenSize() {
  return { width: GetSystemMetrics(0), height: GetSystemMetrics(1) }
}

/**
 * 抓一帧并缩到 outW x outH（最近邻采样，够用且快）。
 * @returns {{width:number,height:number,rgb:Buffer,full:{width:number,height:number}}}
 */
export function capture({ x = 0, y = 0, width, height, outW, outH, maxHeight } = {}) {
  const screen = screenSize()
  const w = Math.max(1, Math.min(width || screen.width, screen.width - x))
  const h = Math.max(1, Math.min(height || screen.height, screen.height - y))

  const screenDc = GetDC(null)
  const memDc = CreateCompatibleDC(screenDc)
  const bmp = CreateCompatibleBitmap(screenDc, w, h)
  const old = SelectObject(memDc, bmp)
  try {
    if (!BitBlt(memDc, 0, 0, w, h, screenDc, x, y, SRCCOPY)) throw new Error('BitBlt failed')
    const bgra = Buffer.alloc(w * h * 4)
    const bi = makeBitmapInfo(w, h)
    if (!GetDIBits(memDc, bmp, 0, h, bgra, bi, 0)) throw new Error('GetDIBits failed')

    // 正高度返回的是自下而上，逐行翻转采样
    // 目标尺寸：给了 outH/maxHeight 就按高度封顶（保比例），否则按宽度
    const capH = outH || maxHeight || 0
    let tw
    let th
    if (capH && capH < h) {
      th = capH
      tw = Math.max(1, Math.round((capH * w) / h))
    } else {
      tw = Math.max(1, outW || Math.round(w / 4))
      th = Math.max(1, Math.round((tw * h) / w))
    }
    const rgb = Buffer.alloc(tw * th * 3)
    for (let ty = 0; ty < th; ty++) {
      const sy = h - 1 - Math.min(h - 1, Math.floor(((ty + 0.5) * h) / th))
      for (let tx = 0; tx < tw; tx++) {
        const sx = Math.min(w - 1, Math.floor(((tx + 0.5) * w) / tw))
        const s = (sy * w + sx) * 4
        const d = (ty * tw + tx) * 3
        rgb[d] = bgra[s + 2]
        rgb[d + 1] = bgra[s + 1]
        rgb[d + 2] = bgra[s]
      }
    }
    return { width: tw, height: th, rgb, full: { width: w, height: h } }
  } finally {
    SelectObject(memDc, old)
    DeleteObject(bmp)
    DeleteDC(memDc)
    ReleaseDC(null, screenDc)
  }
}

/**
 * 块级差分：把两张同尺寸小图切块，返回每个块的平均亮度变化（0-255）。
 */
export function diffBlocks(a, b, { bw = 32, bh = 18 } = {}) {
  if (!a || !b) return { blocks: [], changed: 0, mean: 0, peak: 0, grid: [bw, bh] }
  const w = a.width
  const h = a.height
  const blocks = []
  let total = 0
  let peak = 0
  let changed = 0
  const stepY = Math.max(1, Math.floor(h / bh))
  const stepX = Math.max(1, Math.floor(w / bw))
  for (let by = 0; by + stepY <= h; by += stepY) {
    for (let bx = 0; bx + stepX <= w; bx += stepX) {
      let sum = 0
      const n = stepX * stepY
      for (let yy = 0; yy < stepY; yy++) {
        let idx = ((by + yy) * w + bx) * 3
        for (let xx = 0; xx < stepX; xx++) {
          sum += Math.abs(a.rgb[idx] - b.rgb[idx]) + Math.abs(a.rgb[idx + 1] - b.rgb[idx + 1]) + Math.abs(a.rgb[idx + 2] - b.rgb[idx + 2])
          idx += 3
        }
      }
      const mean = sum / (n * 3)
      total += mean
      if (mean > peak) peak = mean
      if (mean >= 6) changed++
      blocks.push({ x: bx, y: by, w: stepX, h: stepY, v: Math.round(mean * 10) / 10 })
    }
  }
  const mean = blocks.length ? total / blocks.length : 0
  return { blocks: blocks.sort((p, q) => q.v - p.v).slice(0, 12), changed, mean: Math.round(mean * 100) / 100, peak: Math.round(peak * 10) / 10, grid: [stepX, stepY], cells: blocks.length }
}

/** 极简 PNG 编码（filter 0 + deflate），只用于把缓冲里的帧落盘给人看。 */
export function encodePng({ width, height, rgb }) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}
