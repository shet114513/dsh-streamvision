// 把一帧压成"矢量 + 结构化 JSON"：色块合并成矩形路径 → SVG（fill 带颜色），
// 再补一层对象/关系描述（VSL 风格）。目标不是好看，是机器可读、字数量可控。
// 坐标系用网格单位（viewBox 0 0 gw gh），换算回像素只需乘 (W/gw, H/gh)。

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

/** RGB -> HSL（h 0-360, s/l 0-1） */
export function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return { h, s, l }
}

const HUE_NAMES = [[15, '红'], [40, '橙'], [65, '黄'], [150, '绿'], [200, '青'], [250, '蓝'], [290, '紫'], [330, '品红'], [360, '红']]

/** 颜色 → 中文名（色系 + 明暗；低饱和叫灰） */
export function colorName(h, s, l) {
  if (l < 0.08) return '黑'
  if (l > 0.93 && s < 0.12) return '白'
  if (s < 0.10) return l < 0.35 ? '深灰' : l < 0.7 ? '灰' : '浅灰'
  let base = '红'
  for (const [deg, name] of HUE_NAMES) {
    if (h < deg) { base = name; break }
  }
  const tone = l < 0.28 ? '深' : l > 0.78 ? '浅' : ''
  return tone + base
}

function quantKey(h, s, l) {
  if (l < 0.08) return 'K'
  if (s < 0.10) return 'N' + Math.round(l * 4)
  let hue = 0
  const edges = [15, 40, 65, 150, 200, 250, 290, 330, 360]
  for (let i = 0; i < edges.length; i++) {
    if (h < edges[i]) { hue = i; break }
  }
  return 'H' + hue + Math.round(l * 3)
}

function hex(r, g, b) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')
}

/** 采样成 gw×gh 的格子：颜色 + 量化键 */
function grid(img, gw, gh) {
  const { width: w, height: h, rgb } = img
  const cells = new Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const sx = clamp(Math.floor(((x + 0.5) * w) / gw), 0, w - 1)
      const sy = clamp(Math.floor(((y + 0.5) * h) / gh), 0, h - 1)
      const i = (sy * w + sx) * 3
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
      const { h: hh, s, l } = rgb2hsl(r, g, b)
      cells[y * gw + x] = { r, g, b, h: hh, s, l, key: quantKey(hh, s, l) }
    }
  }
  return cells
}

/** 贪心矩形分解：每种颜色在网格上的格子合并成尽量少的矩形 */
function rectsFor(cells, gw, gh) {
  const used = new Uint8Array(gw * gh)
  const out = []
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const at = y * gw + x
      if (used[at]) continue
      const key = cells[at].key
      // 向右扩
      let x2 = x
      while (x2 + 1 < gw && !used[y * gw + x2 + 1] && cells[y * gw + x2 + 1].key === key) x2++
      // 向下扩（整行都得同色且未被占用）
      let y2 = y
      outer: while (y2 + 1 < gh) {
        for (let xx = x; xx <= x2; xx++) {
          const t = (y2 + 1) * gw + xx
          if (used[t] || cells[t].key !== key) break outer
        }
        y2++
      }
      for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) used[yy * gw + xx] = 1
      // 颜色取该矩形内均值
      let rs = 0, gs = 0, bs = 0, n = 0
      for (let yy = y; yy <= y2; yy++) {
        for (let xx = x; xx <= x2; xx++) {
          const c = cells[yy * gw + xx]
          rs += c.r; gs += c.g; bs += c.b; n++
        }
      }
      out.push({ x, y, w: x2 - x + 1, h: y2 - y + 1, fill: hex(rs / n, gs / n, bs / n), cells: n, key })
    }
  }
  return out
}

const r1 = (v) => String(+v.toFixed(2)).replace(/^0\./, '.')

/** 主入口：一帧 → { svg, colors, objects, relations, stats } */
export function toVector(img, { gw = 32, gh = 18, maxObjects = 12, minCells = 2, relations = true } = {}) {
  const cells = grid(img, gw, gh)
  const rects = rectsFor(cells, gw, gh)

  // 先把相近的颜色并成一个调色板条目（不然 60 多种深灰会把对象列表打散）
  const pal = []
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
  const toRgb = (h) => [1, 3, 5].map((p) => parseInt(h.slice(p, p + 2), 16))
  for (const r of rects.slice().sort((a, b) => b.cells - a.cells)) {
    const rgb = toRgb(r.fill)
    let hit = null
    for (const p of pal) {
      if (dist(p.rgb, rgb) < 64) { hit = p; break }
    }
    if (hit) {
      hit.rects.push(r)
      hit.cells += r.cells
    } else {
      pal.push({ rgb, rects: [r], cells: r.cells })
    }
  }
  for (const p of pal) p.fill = hex(p.rgb[0], p.rgb[1], p.rgb[2])
  // 用并过的调色板重算每个矩形的 fill（让 path 与对象一一对应）
  for (const p of pal) for (const r of p.rects) r.fill = p.fill

  const byFill = new Map()
  for (const r of rects) {
    if (!byFill.has(r.fill)) byFill.set(r.fill, [])
    byFill.get(r.fill).push(r)
  }
  const groups = [...byFill.entries()]
    .map(([fill, rs]) => {
      const cellsN = rs.reduce((a, b) => a + b.cells, 0)
      const x0 = Math.min(...rs.map((r) => r.x))
      const y0 = Math.min(...rs.map((r) => r.y))
      const x1 = Math.max(...rs.map((r) => r.x + r.w))
      const y1 = Math.max(...rs.map((r) => r.y + r.h))
      return { fill, rects: rs, cells: cellsN, bbox: [x0, y0, x1, y1] }
    })
    .filter((g) => g.cells >= minCells)
    .sort((a, b) => b.cells - a.cells)
    .slice(0, Math.max(3, Math.min(40, maxObjects)))

  const total = gw * gh
  const objects = groups.map((g, i) => {
    const d = g.rects.map((r) => `M${r.x} ${r.y}h${r.w}v${r.h}H${r.x}z`).join('')
    // 取该组均值色的中文名
    const rs = g.rects
    let hh = 0, ss = 0, ll = 0
    for (const r of rs) {
      const [rr, gg, bb] = [1, 3, 5].map((p) => parseInt(r.fill.slice(p, p + 2), 16))
      const c = rgb2hsl(rr, gg, bb)
      hh += c.h; ss += c.s; ll += c.l
    }
    const n = rs.length
    const name = colorName(hh / n, ss / n, ll / n)
    return {
      id: `o${i + 1}`,
      type: pickType(g, gw, gh),
      fill: g.fill,
      color: name,
      bbox: g.bbox,
      norm: [r1(g.bbox[0] / gw), r1(g.bbox[1] / gh), r1(g.bbox[2] / gw), r1(g.bbox[3] / gh)],
      share: +((g.cells / total) * 100).toFixed(1),
      rects: g.rects.length,
      path: d,
    }
  })

  const svg =
    `<svg viewBox="0 0 ${gw} ${gh}" xmlns="http://www.w3.org/2000/svg">` +
    objects.map((o) => `<path fill="${o.fill}" d="${o.path}"/>`).join('') +
    `</svg>`

  const palette = objects.slice(0, 6).map((o) => o.fill)

  let rel = []
  if (relations && objects.length > 1) {
    for (let i = 0; i < Math.min(4, objects.length); i++) {
      for (let j = i + 1; j < Math.min(5, objects.length); j++) {
        const a = objects[i].bbox
        const b = objects[j].bbox
        const overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
        const inside = a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]
        if (inside) rel.push(`${objects[j].id} in ${objects[i].id}`)
        else if (overlap) rel.push(`${objects[i].id} ~ ${objects[j].id}`)
        else if (a[1] + a[3] <= b[1]) rel.push(`${objects[i].id} above ${objects[j].id}`)
      }
    }
    rel = rel.slice(0, 6)
  }

  // 边缘密度：相邻格颜色差 > 90 的格子占比（%）。用来盲读"这是 UI 密集界面还是空旷场景"
  let edgeCells = 0
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const c = cells[y * gw + x]
      let isEdge = false
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy
        if (nx >= gw || ny >= gh) continue
        const n = cells[ny * gw + nx]
        if (Math.abs(c.r - n.r) + Math.abs(c.g - n.g) + Math.abs(c.b - n.b) > 90) { isEdge = true; break }
      }
      if (isEdge) edgeCells++
    }
  }

  const stats = {
    grid: [gw, gh],
    objects: objects.length,
    rects: rects.length,
    svgChars: svg.length,
    colors: byFill.size,
    edgeCells,
    edgeDensity: Number(((edgeCells / (gw * gh)) * 100).toFixed(1)),
  }
  return { canvas: { w: gw, h: gh, capture: [img.width, img.height] }, palette, objects, relations: rel, svg, stats }
}

function pickType(g, gw, gh) {
  const [x0, y0, x1, y1] = g.bbox
  const w = x1 - x0
  const h = y1 - y0
  const share = g.cells / (gw * gh)
  if (share > 0.35) return 'background'
  if (w <= 2 && h <= 2) return 'dot'
  if (w * h > 0 && g.cells / (w * h) < 0.5) return 'shape'
  if (Math.abs(w - h) <= 1) return 'square'
  return w > h ? 'band' : 'column'
}

/** 两帧矢量结果的差异：哪些对象没了/新出现/挪了 */
export function diffVector(a, b) {
  const key = (o) => `${o.color}|${o.norm.join(',')}`
  const A = new Map((a?.objects || []).map((o) => [key(o), o]))
  const B = new Map((b?.objects || []).map((o) => [key(o), o]))
  const added = [...B].filter(([k]) => !A.has(k)).map(([, o]) => ({ color: o.color, fill: o.fill, norm: o.norm, share: o.share }))
  const gone = [...A].filter(([k]) => !B.has(k)).map(([, o]) => ({ color: o.color, fill: o.fill, norm: o.norm, share: o.share }))
  return { added: added.slice(0, 5), gone: gone.slice(0, 5) }
}
