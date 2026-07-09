import { AgentSettings, AIToolDef, BgMsg, ChatMessage, OfflineChatToolEvent, PopupMsg } from './lib/types'

type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimated?: boolean }
type Segment =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'mcp'; tool: string; success: boolean; arguments: Record<string, any>; result: any; summary: string }

const q = (id: string) => document.getElementById(id)!
const messagesEl = q('messages')
const inputEl = q('input') as HTMLTextAreaElement
const sendBtn = q('send-btn') as HTMLButtonElement
const recallBtn = q('recall-btn') as HTMLButtonElement
const modelBtn = q('model-btn') as HTMLButtonElement
const promptBtn = q('prompt-btn') as HTMLButtonElement
const toolsBtn = q('tools-btn') as HTMLButtonElement
const modelPanel = q('model-panel')
const promptPanel = q('prompt-panel')
const toolPanel = q('tool-panel')
const cfgProvider = q('cfg-ai-provider') as HTMLSelectElement
const cfgAiKey = q('cfg-ai-key') as HTMLInputElement
const cfgAiBase = q('cfg-ai-base') as HTMLInputElement
const cfgAiModel = q('cfg-ai-model') as HTMLInputElement
const modelSave = q('model-save') as HTMLButtonElement
const modelFeedback = q('model-feedback')
const promptInput = q('prompt-input') as HTMLTextAreaElement
const promptSave = q('prompt-save') as HTMLButtonElement
const promptFeedback = q('prompt-feedback')
const modelMeta = q('model-meta')
const toolSearch = q('tool-search') as HTMLInputElement
const toolListEl = q('tool-list')
const toolCount = q('tool-count')
const tokenStatsEl = q('token-stats')
const toolsAllBtn = q('tools-all') as HTMLButtonElement
const toolsNoneBtn = q('tools-none') as HTMLButtonElement

let port: chrome.runtime.Port | null = null
let messages: ChatMessage[] = []
let segments: Segment[] = []
let offlineToolDefs: AIToolDef[] = []
let allowedTools = new Set<string>()
let sending = false
let activeRequestId = ''
let cancelRequested = false
let tokenTotals: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const pending = new Map<string, (msg: BgMsg) => void>()

const PROVIDER_PRESETS: Record<string, { base: string; model: string }> = {
  anthropic:  { base: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  openai:     { base: 'https://api.openai.com',    model: 'gpt-4o' },
  deepseek:   { base: 'https://api.deepseek.com',  model: 'deepseek-chat' },
  openrouter: { base: 'https://openrouter.ai/api', model: 'anthropic/claude-3.5-sonnet' },
  ollama:     { base: 'http://localhost:11434',    model: 'llama3.1' },
}

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function requestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sendRequest<T extends BgMsg>(msg: PopupMsg, match: (reply: BgMsg) => reply is T): Promise<T> {
  if (!port) connectPort()
  const id = (msg as any).requestId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('请求超时'))
    }, 120000)
    pending.set(id, reply => {
      if (!match(reply)) return
      clearTimeout(timer)
      pending.delete(id)
      resolve(reply)
    })
    port!.postMessage(msg)
  })
}

function connectPort() {
  port = chrome.runtime.connect({ name: 'offline-chat' })
  port.onMessage.addListener((msg: BgMsg) => {
    if (msg.type === 'offline-chat:progress') {
      applyProgress(msg.event)
      return
    }
    if ((msg as any).requestId && pending.has((msg as any).requestId)) {
      pending.get((msg as any).requestId)!(msg)
    }
  })
  port.onDisconnect.addListener(() => { port = null })
}

function safeStringify(value: any): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function isImageDataUrl(value: any): boolean {
  return typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value.trim())
}

function collectToolImages(value: any, path = 'result', seen = new Set<any>()): Array<{ label: string; url: string }> {
  if (value == null) return []
  if (typeof value === 'object') {
    if (seen.has(value)) return []
    seen.add(value)
  }
  if (isImageDataUrl(value)) return [{ label: /screenshot|dataUrl|image/i.test(path) ? '截图' : '图片', url: String(value).trim() }]
  if (Array.isArray(value)) return value.flatMap((item, index) => collectToolImages(item, `${path}[${index}]`, seen))
  if (typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) => collectToolImages(item, `${path}.${key}`, seen))
}

function redactImages(value: any, seen = new Set<any>()): any {
  if (value == null) return value
  if (isImageDataUrl(value)) return '[图片已在下方显示]'
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[循环引用]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactImages(item, seen))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactImages(item, seen)]))
}

function detailsSegment(item: Extract<Segment, { type: 'mcp' }>, status: string): HTMLElement {
  const body = [
    `工具: ${item.tool}`,
    `状态: ${status}`,
    '',
    '参数:',
    safeStringify(item.arguments),
    '',
    '结果:',
    safeStringify(redactImages(item.result ?? item.summary)),
  ].join('\n')
  const el = document.createElement('details')
  el.className = 'segment'
  el.innerHTML = `
    <summary>
      <span>MCP 工具 · ${escapeHtml(item.tool)}</span>
      <span class="seg-status ${item.success ? '' : 'fail'}">${escapeHtml(status)}</span>
    </summary>
    <div class="segment-body">${escapeHtml(body)}</div>`
  const images = collectToolImages(item.result)
  const bodyEl = el.querySelector('.segment-body')
  if (images.length && bodyEl) {
    const strip = document.createElement('div')
    strip.className = 'tool-images'
    for (const image of images) {
      const card = document.createElement('figure')
      card.className = 'tool-image'
      card.innerHTML = `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.label)}"/><figcaption>${escapeHtml(image.label)}</figcaption>`
      strip.appendChild(card)
    }
    bodyEl.appendChild(strip)
  }
  return el
}

function formatTokenUsage(): string {
  const suffix = tokenTotals.estimated ? '（含估算）' : ''
  return `本次会话累计 Token：输入 ${tokenTotals.inputTokens} / 输出 ${tokenTotals.outputTokens} / 总计 ${tokenTotals.totalTokens}${suffix}`
}

function addTokenUsage(usage?: TokenUsage) {
  if (!usage) return
  tokenTotals.inputTokens += Number(usage.inputTokens || 0)
  tokenTotals.outputTokens += Number(usage.outputTokens || 0)
  tokenTotals.totalTokens += Number(usage.totalTokens || 0)
  tokenTotals.estimated = tokenTotals.estimated || !!usage.estimated
}

function syncSendButton() {
  sendBtn.textContent = sending ? '停止' : '发送'
  sendBtn.classList.toggle('stop', sending)
  sendBtn.classList.toggle('primary', !sending)
  sendBtn.disabled = !sending && !inputEl.value.trim()
}

function render() {
  messagesEl.innerHTML = ''
  if (!segments.length) {
    const empty = document.createElement('div')
    empty.className = 'msg system'
    empty.textContent = '输入消息后，AI 会直接使用本机模型配置，并可调用浏览器 MCP 工具。'
    messagesEl.appendChild(empty)
  }
  for (const item of segments) {
    if (item.type === 'message') {
      const el = document.createElement('div')
      el.className = `msg ${item.role}`
      el.innerHTML = escapeHtml(item.content)
      messagesEl.appendChild(el)
    } else {
      const status = item.summary === '执行中...' ? '执行中' : (item.success ? '成功' : '失败')
      messagesEl.appendChild(detailsSegment(item, status))
    }
  }
  tokenStatsEl.textContent = formatTokenUsage()
  recallBtn.disabled = sending || segments.length === 0
  syncSendButton()
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderTools() {
  const keyword = toolSearch.value.trim().toLowerCase()
  const visible = offlineToolDefs.filter(t => !keyword || t.name.toLowerCase().includes(keyword) || String(t.description || '').toLowerCase().includes(keyword))
  toolCount.textContent = `本次对话可用 ${allowedTools.size}/${offlineToolDefs.length} 个 MCP 工具`
  toolListEl.innerHTML = ''
  for (const tool of visible) {
    const label = document.createElement('label')
    label.className = 'tool-item'
    label.title = tool.description || tool.name
    label.innerHTML = `<input type="checkbox" ${allowedTools.has(tool.name) ? 'checked' : ''}/><span>${escapeHtml(tool.name)}</span>`
    label.querySelector('input')!.addEventListener('change', e => {
      const checked = (e.target as HTMLInputElement).checked
      checked ? allowedTools.add(tool.name) : allowedTools.delete(tool.name)
      renderTools()
    })
    toolListEl.appendChild(label)
  }
}

function renderModelMeta(settings: Partial<AgentSettings>) {
  const model = String(settings.aiModel || '').trim() || '未配置模型'
  const base = String(settings.aiBaseUrl || '').trim() || '未配置 Base URL'
  const keySuffix = settings.aiKey ? '' : ' · 未配置 AI Key'
  modelMeta.textContent = `${model} · ${base}${keySuffix}`
}

function applyProgress(event: any) {
  if (!activeRequestId) return
  if (event.type === 'tool_start') {
    segments.push({ type: 'mcp', tool: event.tool || 'unknown', success: true, arguments: event.arguments || {}, result: null, summary: '执行中...' })
    render()
  } else if (event.type === 'tool_result' && event.event) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]
      if (seg.type === 'mcp' && seg.tool === event.event.tool && seg.summary === '执行中...') {
        segments[i] = { type: 'mcp', ...event.event }
        render()
        return
      }
    }
    segments.push({ type: 'mcp', ...event.event })
    render()
  }
}

async function loadConfig() {
  const id = requestId('cfg')
  const cfg = await sendRequest({ type: 'offline-chat:get-config', requestId: id }, (m): m is Extract<BgMsg, { type: 'offline-chat:config' }> => m.type === 'offline-chat:config' && m.requestId === id)
  cfgAiKey.value = cfg.settings.aiKey || ''
  cfgAiBase.value = cfg.settings.aiBaseUrl || ''
  cfgAiModel.value = cfg.settings.aiModel || ''
  promptInput.value = cfg.settings.offlinePrompt || ''
  renderModelMeta(cfg.settings)
}

async function loadTools() {
  const id = requestId('tools')
  const reply = await sendRequest({ type: 'offline-chat:list-tools', requestId: id }, (m): m is Extract<BgMsg, { type: 'offline-chat:tools' }> => m.type === 'offline-chat:tools' && m.requestId === id)
  offlineToolDefs = reply.tools || []
  allowedTools = new Set(offlineToolDefs.map(t => t.name))
  renderTools()
}

async function saveModel() {
  const id = requestId('model')
  const reply = await sendRequest({
    type: 'offline-chat:save-model',
    requestId: id,
    payload: {
      aiKey: cfgAiKey.value.trim(),
      aiBaseUrl: cfgAiBase.value.trim() || 'https://api.anthropic.com',
      aiModel: cfgAiModel.value.trim() || 'claude-sonnet-4-5',
    },
  }, (m): m is Extract<BgMsg, { type: 'offline-chat:model-saved' }> => m.type === 'offline-chat:model-saved' && m.requestId === id)
  if (!reply.ok || !reply.settings) {
    modelFeedback.textContent = reply.error || '保存失败'
    return
  }
  cfgAiKey.value = reply.settings.aiKey || ''
  cfgAiBase.value = reply.settings.aiBaseUrl || ''
  cfgAiModel.value = reply.settings.aiModel || ''
  renderModelMeta(reply.settings)
  modelFeedback.textContent = '已保存'
  setTimeout(() => { modelFeedback.textContent = '' }, 1600)
}

async function savePrompt() {
  const id = requestId('prompt')
  await sendRequest({ type: 'offline-chat:save-prompt', requestId: id, prompt: promptInput.value }, (m): m is Extract<BgMsg, { type: 'offline-chat:prompt-saved' }> => m.type === 'offline-chat:prompt-saved' && m.requestId === id)
  promptFeedback.textContent = '已保存'
  setTimeout(() => { promptFeedback.textContent = '' }, 1600)
}

async function send() {
  const text = inputEl.value.trim()
  if (!text || sending) return
  inputEl.value = ''
  messages.push({ role: 'user', content: text })
  segments.push({ type: 'message', role: 'user', content: text })
  sending = true
  cancelRequested = false
  activeRequestId = requestId('offline')
  render()
  try {
    const result = await sendRequest({ type: 'offline-chat:send', requestId: activeRequestId, messages, prompt: promptInput.value.trim(), allowedTools: Array.from(allowedTools) }, (m): m is Extract<BgMsg, { type: 'offline-chat:response' | 'offline-chat:error' }> => (m.type === 'offline-chat:response' || m.type === 'offline-chat:error') && m.requestId === activeRequestId)
    if (result.type === 'offline-chat:error') {
      if (!cancelRequested) {
        messages.push({ role: 'assistant', content: `失败：${result.error}` })
        segments.push({ type: 'message', role: 'assistant', content: `失败：${result.error}` })
      }
    } else {
      addTokenUsage(result.usage)
      messages.push({ role: 'assistant', content: result.text || '完成' })
      segments.push({ type: 'message', role: 'assistant', content: result.text || '完成' })
      for (const ev of result.toolEvents || []) {
        const exists = segments.some(s => s.type === 'mcp' && s.tool === ev.tool && safeStringify(s.arguments) === safeStringify(ev.arguments))
        if (!exists) segments.splice(Math.max(0, segments.length - 1), 0, { type: 'mcp', ...ev })
      }
    }
  } finally {
    sending = false
    activeRequestId = ''
    cancelRequested = false
    render()
    inputEl.focus()
  }
}

async function stopSending() {
  if (!sending || !activeRequestId || !port) return
  cancelRequested = true
  port.postMessage({ type: 'offline-chat:cancel', requestId: activeRequestId } satisfies PopupMsg)
}

function recall() {
  if (sending || !messages.length) return
  if (messages[messages.length - 1]?.role === 'assistant') messages.pop()
  if (messages[messages.length - 1]?.role === 'user') messages.pop()
  const lastUser = segments.map((s, i) => s.type === 'message' && s.role === 'user' ? i : -1).filter(i => i >= 0).pop()
  if (typeof lastUser === 'number') segments = segments.slice(0, lastUser)
  render()
}

sendBtn.addEventListener('click', () => { sending ? void stopSending() : void send() })
recallBtn.addEventListener('click', recall)
modelBtn.addEventListener('click', () => modelPanel.classList.toggle('open'))
promptBtn.addEventListener('click', () => promptPanel.classList.toggle('open'))
toolsBtn.addEventListener('click', () => toolPanel.classList.toggle('open'))
inputEl.addEventListener('input', () => { if (!sending) syncSendButton() })
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
})
cfgProvider.addEventListener('change', () => {
  const p = PROVIDER_PRESETS[cfgProvider.value]
  if (p) { cfgAiBase.value = p.base; cfgAiModel.value = p.model }
  cfgProvider.value = ''
})
modelSave.addEventListener('click', () => void saveModel())
promptSave.addEventListener('click', () => void savePrompt())
toolSearch.addEventListener('input', renderTools)
toolsAllBtn.addEventListener('click', () => {
  allowedTools = new Set(offlineToolDefs.map(t => t.name))
  renderTools()
})
toolsNoneBtn.addEventListener('click', () => {
  allowedTools.clear()
  renderTools()
})

connectPort()
void Promise.all([loadConfig(), loadTools()])
  .then(() => { render(); inputEl.focus() })
  .catch(err => { modelMeta.textContent = err?.message || String(err); render() })
