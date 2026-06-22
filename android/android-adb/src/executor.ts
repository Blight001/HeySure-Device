// Tool catalog for the ADB form. Tool NAMES and arg schemas are kept identical
// to the on-device app (方案 A) so the model sees one consistent Android tool
// surface regardless of which form is connected. Implementations differ: here
// everything goes through `adb`.

import os from 'os'
import path from 'path'
import fs from 'fs'
import * as adb from './adb'

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, any>
  destructive?: boolean
}

type Handler = (t: adb.AdbTarget, args: Record<string, any>) => Promise<any>

interface Tool {
  def: ToolDef
  run: Handler
}

const obj = (properties: Record<string, any>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
})
const int = (description: string) => ({ type: 'integer', description })
const str = (description: string) => ({ type: 'string', description })

const tools: Tool[] = [
  {
    def: { name: 'touch.tap', description: '在屏幕坐标 (x, y) 处单击（像素，原点左上角）。', input_schema: obj({ x: int('横坐标，像素'), y: int('纵坐标，像素') }, ['x', 'y']) },
    run: async (t, a) => { await adb.tap(t, a.x, a.y); return { ok: true, x: a.x, y: a.y } },
  },
  {
    def: { name: 'touch.long_press', description: '在 (x, y) 处长按指定毫秒数。', input_schema: obj({ x: int('横坐标'), y: int('纵坐标'), duration_ms: int('长按时长，毫秒，默认 600') }, ['x', 'y']) },
    run: async (t, a) => { const d = Number(a.duration_ms) || 600; await adb.swipe(t, a.x, a.y, a.x, a.y, d); return { ok: true } },
  },
  {
    def: { name: 'touch.swipe', description: '从 (x1, y1) 滑动到 (x2, y2)，可指定时长（毫秒）。用于滑动、翻页、拖拽。', input_schema: obj({ x1: int('起点横'), y1: int('起点纵'), x2: int('终点横'), y2: int('终点纵'), duration_ms: int('时长毫秒，默认 300') }, ['x1', 'y1', 'x2', 'y2']) },
    run: async (t, a) => { await adb.swipe(t, a.x1, a.y1, a.x2, a.y2, Number(a.duration_ms) || 300); return { ok: true } },
  },
  {
    def: { name: 'touch.back', description: '系统返回键。', input_schema: obj({}) },
    run: async (t) => { await adb.keyevent(t, 4); return { ok: true } },
  },
  {
    def: { name: 'touch.home', description: '回到桌面（Home 键）。', input_schema: obj({}) },
    run: async (t) => { await adb.keyevent(t, 3); return { ok: true } },
  },
  {
    def: { name: 'touch.recents', description: '打开最近任务。', input_schema: obj({}) },
    run: async (t) => { await adb.keyevent(t, 187); return { ok: true } },
  },
  {
    def: { name: 'touch.wake', description: '点亮/唤醒屏幕（息屏时先调用它）。安全锁屏仍需手动解锁。', input_schema: obj({ unlock: { type: 'boolean', description: '是否尝试滑动解锁（仅无密码锁屏有效）' } }) },
    run: async (t, a) => { if (a.unlock) await adb.wakeAndUnlock(t); else await adb.wake(t); return { ok: true } },
  },
  {
    def: { name: 'input.text', description: '向当前聚焦的输入框输入文本（需先点击聚焦输入框）。', input_schema: obj({ text: str('要输入的文本') }, ['text']) },
    run: async (t, a) => { await adb.inputText(t, String(a.text ?? '')); return { ok: true } },
  },
  {
    def: { name: 'screen.capture', description: '对手机屏幕截图，返回 PNG 图片。', input_schema: obj({}) },
    run: async (t) => {
      // Wake first, otherwise screencap returns a black frame on a dark screen.
      await adb.wake(t).catch(() => {})
      const png = await adb.screencapPng(t)
      return { dataUrl: 'data:image/png;base64,' + png.toString('base64'), send_to_user: true }
    },
  },
  {
    def: { name: 'screen.record', description: '录制屏幕一段时间，生成 mp4 并返回宿主机路径（adb 录屏不含音频）。', input_schema: obj({ duration_ms: int('录制时长毫秒，默认 5000，最长 180000') }) },
    run: async (t, a) => {
      const sec = Math.max(1, Math.min(180, Math.round((Number(a.duration_ms) || 5000) / 1000)))
      const hostPath = path.join(os.tmpdir(), `heysure-rec-${Date.now()}.mp4`)
      await adb.screenrecord(t, sec, hostPath)
      const size = fs.existsSync(hostPath) ? fs.statSync(hostPath).size : 0
      return { path: hostPath, size_bytes: size }
    },
  },
]

const byName = new Map(tools.map(t => [t.def.name, t]))

export const toolNames = (): string[] => tools.map(t => t.def.name).sort()
export const toolDefs = (): ToolDef[] => tools.map(t => t.def)

export interface TaskOutcome { success: boolean; tool: string; result: any; summary: string }

export async function executeTask(
  target: adb.AdbTarget,
  tool: string,
  args: Record<string, any>,
  allowedTools?: string[],
): Promise<TaskOutcome> {
  const entry = byName.get(tool)
  if (!entry) {
    return { success: false, tool, result: null, summary: `Unknown tool: ${tool}. Use one of: ${toolNames().join(', ')}` }
  }
  if (allowedTools && allowedTools.length && !allowedTools.includes(tool)) {
    return { success: false, tool, result: null, summary: `Tool not allowed for this task: ${tool}.` }
  }
  try {
    const result = await entry.run(target, args || {})
    return { success: true, tool, result, summary: `${tool} completed successfully` }
  } catch (err: any) {
    return { success: false, tool, result: null, summary: err?.message || String(err) }
  }
}
