// 可插拔 OCR 接口（2026-11-18）
//
// 默认引擎：Windows 自带 WinRT OCR（离线、快，但中文小字错字多）。
// 想让 sv 用别的引擎（PP-OCRv6 / RapidOCR / 云 OCR / 自建服务），不必改插件源码，三种挂法任选：
//
// 1) 配置文件 data/ocr.json（推荐，重启/下一拍即生效）：
//    { "cmd": "python", "args": ["C:/tools/ocr.py", "{file}"], "timeoutMs": 20000 }
//    占位符：{file} 图片绝对路径、{scale} 放大倍数、{top}/{bottom} 裁剪比例（0~1）
//    约定输出：stdout 打一行 JSON {"text":"..."}，或直接打纯文本（都认）。
//    可选 {"engine":"winrt"} 显式用默认引擎。
//
// 2) 环境变量：SV_OCR_CMD / SV_OCR_ARGS（ARGS 用空格分隔，同样支持占位符）
//
// 3) 代码内注册（同进程内使用，宿主插件自己实现时可调）：
//    import { registerOcrHook } from './ocr.js'
//    registerOcrHook(async (file, opts) => ({ ok: true, text: '...' }))
//
// 任何一步失败都自动回退到 WinRT，并把错误留在返回值里，不会静默变空。

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'data')
const OCR_PS1 = path.join(HERE, 'ocr.ps1')

let HOOK = null // (file, opts) => Promise<{ok, text, ms?}>
let HOOK_NAME = ''

/** 代码内注册自定义引擎（传 null 取消）。 */
export function registerOcrHook(fn, name = 'custom') {
  HOOK = typeof fn === 'function' ? fn : null
  HOOK_NAME = HOOK ? name : ''
  return { registered: !!HOOK, name: HOOK_NAME }
}

/** 读 data/ocr.json；坏文件返回 {error} 不影响默认引擎。 */
export function readOcrConfig() {
  const f = path.join(DATA, 'ocr.json')
  try {
    if (!fs.existsSync(f)) return {}
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch (e) {
    return { error: 'bad-config: ' + String(e.message || e).slice(-120) }
  }
}

/** 当前生效的引擎描述（给 sv_text/sv_info 报状态用）。 */
export function ocrEngineInfo() {
  if (HOOK) return { engine: 'custom', name: HOOK_NAME }
  const cfg = readOcrConfig()
  if (cfg.error) return { engine: 'winrt', warning: cfg.error }
  const cmd = cfg.cmd || process.env.SV_OCR_CMD || ''
  if (!cmd) return { engine: 'winrt' }
  const args = cfg.args || (process.env.SV_OCR_ARGS ? String(process.env.SV_OCR_ARGS).split(' ').filter(Boolean) : [])
  return { engine: 'cmd', cmd, args, timeoutMs: cfg.timeoutMs || 20000 }
}

function fill(tpl, file, opts) {
  return String(tpl)
    .replace(/\{file\}/g, file)
    .replace(/\{scale\}/g, String(opts.scale ?? 3))
    .replace(/\{top\}/g, String(opts.top ?? 0))
    .replace(/\{bottom\}/g, String(opts.bottom ?? 1))
}

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => {
      const ms = Date.now() - t0
      if (err) return resolve({ ok: false, ms, error: String(err.message || err).slice(-200) })
      const raw = String(stdout || '').trim()
      if (!raw) return resolve({ ok: false, ms, error: 'empty-stdout' })
      const last = raw.split('\n').pop()
      try {
        const j = JSON.parse(last)
        if (j && typeof j.text === 'string') return resolve({ ok: true, ms, text: j.text, raw: j })
      } catch { /* 不是 JSON，按纯文本 */ }
      resolve({ ok: true, ms, text: raw })
    })
  })
}

function runWinRT(file, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1,
        '-Path', file, '-CropTop', String(opts.top ?? 0), '-CropBottom', String(opts.bottom ?? 1), '-Scale', String(opts.scale ?? 3)],
      { encoding: 'utf8', timeout: opts.timeoutMs || 20000, maxBuffer: 8 << 20, windowsHide: true },
      (err, stdout) => {
        const ms = Date.now() - t0
        if (err) return resolve({ ok: false, ms, engine: 'winrt', error: String(err.message || err).slice(-160) })
        try {
          const j = JSON.parse(String(stdout || '').trim().split('\n').pop())
          resolve({ ...j, ok: j.ok !== false, ms, engine: 'winrt' })
        } catch {
          resolve({ ok: false, ms, engine: 'winrt', error: 'bad-json' })
        }
      },
    )
  })
}

/**
 * 统一入口：自定义引擎优先，失败自动回退 WinRT。
 * @returns {Promise<{ok:boolean, text?:string, engine?:string, ms?:number, fallback?:string, error?:string}>}
 */
export async function ocrFile(file, { scale = 3, top = 0, bottom = 1, timeoutMs = 20000 } = {}) {
  const opts = { scale, top, bottom, timeoutMs }

  if (HOOK) {
    try {
      const r = await HOOK(file, opts)
      if (r && r.ok !== false && typeof r.text === 'string') return { ...r, ok: true, engine: 'custom', name: HOOK_NAME }
      const fb = await runWinRT(file, opts)
      return { ...fb, fallback: 'custom: ' + String((r && r.error) || 'no-text').slice(-120) }
    } catch (e) {
      const fb = await runWinRT(file, opts)
      return { ...fb, fallback: 'custom: ' + String(e.message || e).slice(-120) }
    }
  }

  const cfg = readOcrConfig()
  const cmd = cfg.cmd || process.env.SV_OCR_CMD || ''
  if (cmd) {
    const argsTpl = cfg.args || (process.env.SV_OCR_ARGS ? String(process.env.SV_OCR_ARGS).split(' ').filter(Boolean) : [])
    const args = argsTpl.map((a) => fill(a, file, opts))
    const r = await runCmd(cmd, args, cfg.timeoutMs || timeoutMs)
    if (r.ok) return { ...r, engine: 'cmd' }
    const fb = await runWinRT(file, opts)
    return { ...fb, fallback: 'cmd: ' + String(r.error || '').slice(-140) }
  }

  return runWinRT(file, opts)
}
