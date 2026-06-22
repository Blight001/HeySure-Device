// Best-effort tool inference from a free-text instruction.
// Used when the server dispatches a task without an explicit `tool` field —
// matches Chinese + English keywords against built-in tool ids.

interface Rule { pattern: RegExp; tool: string }

const RULES: Rule[] = [
  { pattern: /截图|screenshot|screen capture|屏幕/, tool: 'vision.capture' },
  { pattern: /大段文本|长文本|粘贴输入|输入大段|paste text|large text|text input/, tool: 'text.input' },
  { pattern: /键盘|输入文字|type text|keyboard/,    tool: 'keyboard.type' },
  { pattern: /点击|click|鼠标/,                     tool: 'mouse.click' },
  { pattern: /窗口列表|list window/,                tool: 'window.list' },
  { pattern: /剪贴板|clipboard/,                    tool: 'clipboard.get' },
  { pattern: /朗读|播报|语音播放|tts|speak/,         tool: 'speech.speak' },
  { pattern: /手势|输入状态|鼠标状态|键盘状态|hands/, tool: 'hands.snapshot' },
  { pattern: /鼠标附近|鼠标截图|vision mouse|鼠标周围/, tool: 'vision.capture_mouse' },
  { pattern: /运行|执行|run|命令|command/,          tool: 'shell.run' },
]

const DEFAULT_TOOL = 'shell.run'

export function inferTool(instruction: string): string {
  const t = (instruction || '').toLowerCase()
  for (const rule of RULES) {
    if (rule.pattern.test(t)) return rule.tool
  }
  return DEFAULT_TOOL
}
