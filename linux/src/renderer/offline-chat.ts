type ChatMessage = { role: 'user' | 'assistant'; content: string }
type OfflineToolDef = { name: string; description: string }
type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimated?: boolean }
type Segment =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'think'; content: string }
  | { type: 'mcp'; tool: string; success: boolean; arguments: Record<string, any>; result: any; summary: string }
const api = (window as any).heysureAPI as {
  getSettings: () => Promise<any>
  saveSettings: (settings: any) => Promise<any>
  getOfflineChatConfig: () => Promise<{ localMode?: boolean; prompt: string; aiBaseUrl: string; aiModel: string; hasAiKey: boolean }>
  saveOfflinePrompt: (prompt: string) => Promise<boolean>
  sendOfflineChat: (payload: { requestId?: string; messages: ChatMessage[]; prompt?: string; allowedTools?: string[] }) => Promise<{
    text: string
    think?: string
    toolsUsed: string[]
    toolEvents: Array<{ tool: string; arguments: Record<string, any>; success: boolean; result: any; summary: string }>
    usage?: TokenUsage
  }>
  cancelOfflineChat: (payload: { requestId?: string }) => Promise<boolean>
  onOfflineChatProgress: (cb: (event: any) => void) => () => void
  mcpList: () => Promise<{ tools: OfflineToolDef[]; enabled?: Record<string, boolean> }>
}

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
const imageViewer = q('image-viewer')
const imageViewerImg = q('image-viewer-img') as HTMLImageElement
const imageViewerTitle = q('image-viewer-title')
const imageViewerClose = q('image-viewer-close') as HTMLButtonElement
const imageViewerStage = q('image-viewer-stage')

let messages: ChatMessage[] = []
let segments: Segment[] = []
let offlineToolDefs: OfflineToolDef[] = []
let allowedTools = new Set<string>()
let sending = false
let activeRequestId = ''
let liveAssistantIndex = -1
let liveThinkIndex = -1
let liveToolEvents = 0
let streamedThink = false
let cancelRequested = false
let tokenTotals: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

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

function render() {
  messagesEl.innerHTML = ''
  if (!segments.length) {
    const empty = document.createElement('div')
    empty.className = 'msg system'
    empty.textContent = '输入消息后，AI 会直接使用本机模型配置，并可调用本机 MCP 工具。'
    messagesEl.appendChild(empty)
  }
  for (const item of segments) {
    if (item.type === 'message') {
      const el = document.createElement('div')
      el.className = `msg ${item.role}`
      el.innerHTML = escapeHtml(item.content)
      messagesEl.appendChild(el)
    } else if (item.type === 'think') {
      if (!item.content.trim()) continue
      const el = detailsSegment('深度思考', item.content, true)
      el.classList.add('think')
      messagesEl.appendChild(el)
    } else {
      const status = item.summary === '执行中...' ? '执行中' : (item.success ? '成功' : '失败')
      messagesEl.appendChild(mcpSegment(item, status))
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight
  tokenStatsEl.textContent = formatTokenUsage()
  recallBtn.disabled = sending || segments.length === 0
  syncSendButton()
}

function detailsSegment(label: string, content: string, open = false, success = true, statusText?: string): HTMLElement {
  const el = document.createElement('details')
  el.className = 'segment'
  el.open = open
  el.innerHTML = `
    <summary>
      <span>${escapeHtml(label)}</span>
      ${label.startsWith('MCP') ? `<span class="seg-status ${success ? '' : 'fail'}">${escapeHtml(statusText || (success ? '成功' : '失败'))}</span>` : ''}
    </summary>
    <div class="segment-body">${escapeHtml(content)}</div>`
  return el
}

function appendThinkDelta(text: string) {
  const delta = String(text || '')
  if (!delta) return
  streamedThink = true
  if (liveThinkIndex < 0 || segments[liveThinkIndex]?.type !== 'think') {
    liveThinkIndex = insertBeforeLiveAssistant({ type: 'think', content: '' })
  }
  const seg = segments[liveThinkIndex]
  if (seg?.type !== 'think') return
  seg.content += delta
  render()
}

function appendFinalThink(text: string) {
  const content = String(text || '').trim()
  if (!content) return
  insertBeforeLiveAssistant({ type: 'think', content })
}

function offlineSafeStringify(value: any): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function syncSendButton() {
  sendBtn.textContent = sending ? '停止' : '发送'
  sendBtn.title = sending ? '停止当前生成' : '发送消息'
  sendBtn.classList.toggle('stop', sending)
  sendBtn.classList.toggle('primary', !sending)
  sendBtn.disabled = !sending && !inputEl.value.trim()
}

function addTokenUsage(usage?: TokenUsage) {
  if (!usage) return
  tokenTotals.inputTokens += Number(usage.inputTokens || 0)
  tokenTotals.outputTokens += Number(usage.outputTokens || 0)
  tokenTotals.totalTokens += Number(usage.totalTokens || 0)
  tokenTotals.estimated = tokenTotals.estimated || !!usage.estimated
}

function formatTokenUsage(): string {
  const suffix = tokenTotals.estimated ? '（含估算）' : ''
  return `本次会话累计 Token：输入 ${tokenTotals.inputTokens} / 输出 ${tokenTotals.outputTokens} / 总计 ${tokenTotals.totalTokens}${suffix}`
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
      if (checked) allowedTools.add(tool.name)
      else allowedTools.delete(tool.name)
      renderTools()
    })
    toolListEl.appendChild(label)
  }
}

function insertBeforeLiveAssistant(segment: Segment): number {
  if (liveAssistantIndex >= 0 && segments[liveAssistantIndex]?.type === 'message') {
    segments.splice(liveAssistantIndex, 0, segment)
    const inserted = liveAssistantIndex
    liveAssistantIndex += 1
    if (liveThinkIndex >= inserted) liveThinkIndex += 1
    return inserted
  }
  segments.push(segment)
  return segments.length - 1
}

function ensureLiveAssistantSegment(): number {
  if (liveAssistantIndex >= 0 && segments[liveAssistantIndex]?.type === 'message') return liveAssistantIndex
  segments.push({ type: 'message', role: 'assistant', content: '' })
  liveAssistantIndex = segments.length - 1
  return liveAssistantIndex
}

function applyProgress(event: any) {
  if (!activeRequestId || event?.requestId !== activeRequestId) return
  if (event.type === 'think_delta' && event.text) {
    appendThinkDelta(event.text)
    return
  }
  if (event.type === 'text_delta' && event.text) {
    const idx = ensureLiveAssistantSegment()
    ;(segments[idx] as any).content += String(event.text)
    render()
    return
  }
  if (event.type === 'tool_start') {
    insertBeforeLiveAssistant({
      type: 'mcp',
      tool: event.tool || 'unknown',
      success: true,
      arguments: event.arguments || {},
      result: null,
      summary: '执行中...',
    })
    liveToolEvents++
    render()
    return
  }
  if (event.type === 'tool_result' && event.event) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]
      if (seg.type === 'mcp' && seg.tool === event.event.tool && seg.summary === '执行中...') {
        segments[i] = { type: 'mcp', ...event.event }
        render()
        return
      }
    }
    insertBeforeLiveAssistant({ type: 'mcp', ...event.event })
    liveToolEvents++
    render()
  }
}

function renderModelMeta(settings: any) {
  const model = String(settings.aiModel || '').trim() || '未配置模型'
  const base = String(settings.aiBaseUrl || '').trim() || '未配置 Base URL'
  const keySuffix = settings.aiKey ? '' : ' · 未配置 AI Key'
  modelMeta.textContent = `${model} · ${base}${keySuffix}`
}

function isImageDataUrl(value: any): boolean {
  return typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value.trim())
}

function imageLabel(path: string, tool: string): string {
  if (/capture|screenshot|dataUrl|image/i.test(path)) return '截图'
  return tool === 'mouse.click' ? '点击结果图' : '图片'
}

function collectToolImages(value: any, tool: string, path = 'result', seen = new Set<any>()): Array<{ label: string; url: string }> {
  if (value == null) return []
  if (typeof value === 'object') {
    if (seen.has(value)) return []
    seen.add(value)
  }
  if (isImageDataUrl(value)) return [{ label: imageLabel(path, tool), url: String(value).trim() }]
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectToolImages(item, tool, `${path}[${index}]`, seen))
  }
  if (typeof value !== 'object') return []
  const out: Array<{ label: string; url: string }> = []
  for (const [key, item] of Object.entries(value)) {
    out.push(...collectToolImages(item, tool, `${path}.${key}`, seen))
  }
  return out
}

function openImageViewer(url: string, label: string) {
  imageViewerImg.src = url
  imageViewerImg.alt = label || '图片预览'
  imageViewerTitle.textContent = label || '图片预览'
  imageViewer.classList.add('open')
  imageViewer.setAttribute('aria-hidden', 'false')
}

function closeImageViewer() {
  imageViewer.classList.remove('open')
  imageViewer.setAttribute('aria-hidden', 'true')
  imageViewerImg.removeAttribute('src')
}

function toolImageStrip(images: Array<{ label: string; url: string }>): HTMLElement | null {
  const strip = document.createElement('div')
  strip.className = 'tool-images'
  const seen = new Set<string>()
  for (const image of images) {
    if (seen.has(image.url)) continue
    seen.add(image.url)
    const card = document.createElement('figure')
    card.className = 'tool-image'
    const button = document.createElement('button')
    button.type = 'button'
    button.title = '放大查看'
    button.setAttribute('aria-label', `放大查看${image.label}`)
    const img = document.createElement('img')
    img.src = image.url
    img.alt = image.label
    img.loading = 'lazy'
    button.appendChild(img)
    button.addEventListener('click', () => openImageViewer(image.url, image.label))
    const caption = document.createElement('figcaption')
    caption.textContent = `${image.label} · 点击放大`
    card.appendChild(button)
    card.appendChild(caption)
    strip.appendChild(card)
  }
  return strip.childElementCount ? strip : null
}

function redactToolImages(value: any, seen = new Set<any>()): any {
  if (value == null) return value
  if (isImageDataUrl(value)) return '[图片已在下方显示]'
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[循环引用]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactToolImages(item, seen))
  const out: Record<string, any> = {}
  for (const [key, item] of Object.entries(value)) out[key] = redactToolImages(item, seen)
  return out
}

function mcpSegment(item: Extract<Segment, { type: 'mcp' }>, status: string): HTMLElement {
  const body = [
    `工具: ${item.tool}`,
    `状态: ${status}`,
    '',
    '参数:',
    offlineSafeStringify(item.arguments),
    '',
    '结果:',
    offlineSafeStringify(redactToolImages(item.result ?? item.summary)),
  ].join('\n')
  const details = detailsSegment(`MCP 工具 · ${item.tool}`, body, false, item.success, status)
  const images = collectToolImages(item.result, item.tool)
  if (!images.length) return details
  const wrap = document.createElement('div')
  wrap.className = 'mcp-block'
  wrap.appendChild(details)
  const strip = toolImageStrip(images)
  if (strip) wrap.appendChild(strip)
  return wrap
}

function isCanceledError(err: any): boolean {
  const name = String(err?.name || '')
  const message = String(err?.message || err || '')
  return name === 'AbortError' || /已停止|aborted|canceled|cancelled/i.test(message)
}

async function loadModelSettings() {
  const s = await api.getSettings()
  cfgAiKey.value = s.aiKey || ''
  cfgAiBase.value = s.aiBaseUrl || ''
  cfgAiModel.value = s.aiModel || ''
  renderModelMeta(s)
}

async function send() {
  const text = inputEl.value.trim()
  if (!text || sending) return
  inputEl.value = ''
  messages.push({ role: 'user', content: text })
  segments.push({ type: 'message', role: 'user', content: text })
  sending = true
  activeRequestId = `offline-${Date.now()}-${Math.random().toString(16).slice(2)}`
  liveAssistantIndex = -1
  liveThinkIndex = -1
  liveToolEvents = 0
  streamedThink = false
  cancelRequested = false
  render()
  const pending = document.createElement('div')
  pending.className = 'msg system'
  pending.textContent = 'AI 正在处理...'
  messagesEl.appendChild(pending)
  messagesEl.scrollTop = messagesEl.scrollHeight
  try {
    const result = await api.sendOfflineChat({
      requestId: activeRequestId,
      messages,
      prompt: promptInput.value.trim(),
      allowedTools: Array.from(allowedTools),
    })
    addTokenUsage(result.usage)
    if (!cancelRequested) {
      if (result.think && !streamedThink) {
        appendFinalThink(result.think)
      }
      if (liveToolEvents === 0) {
        for (const ev of result.toolEvents || []) insertBeforeLiveAssistant({ type: 'mcp', ...ev })
      }
      messages.push({ role: 'assistant', content: result.text || '完成' })
      if (liveAssistantIndex >= 0 && segments[liveAssistantIndex]?.type === 'message') {
        ;(segments[liveAssistantIndex] as any).content = result.text || '完成'
      } else {
        segments.push({ type: 'message', role: 'assistant', content: result.text || '完成' })
      }
    }
  } catch (err: any) {
    if (!isCanceledError(err)) {
      messages.push({ role: 'assistant', content: `失败：${err?.message || err}` })
      segments.push({ type: 'message', role: 'assistant', content: `失败：${err?.message || err}` })
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
  if (!sending || !activeRequestId) return
  const requestId = activeRequestId
  cancelRequested = true
  activeRequestId = ''
  try {
    await api.cancelOfflineChat({ requestId })
  } catch {
    // Ignore cancellation transport errors; the send promise will settle.
  }
}

function recall() {
  if (sending || !messages.length) return
  if (messages[messages.length - 1]?.role === 'assistant') messages.pop()
  if (messages[messages.length - 1]?.role === 'user') messages.pop()
  const lastUser = segments.map((s, i) => s.type === 'message' && s.role === 'user' ? i : -1).filter(i => i >= 0).pop()
  if (typeof lastUser === 'number') segments = segments.slice(0, lastUser)
  render()
}

async function initOfflineChat() {
  const cfg = await api.getOfflineChatConfig()
  const mcp = await api.mcpList()
  const enabled = mcp.enabled || {}
  offlineToolDefs = (mcp.tools || [])
    .filter(t => enabled[t.name] !== false)
    .map(t => ({ name: t.name, description: t.description || '' }))
  allowedTools = new Set(offlineToolDefs.map(t => t.name))
  promptInput.value = cfg.prompt || ''
  await loadModelSettings()
  render()
  renderTools()
  inputEl.focus()
}

sendBtn.addEventListener('click', () => {
  if (sending) void stopSending()
  else void send()
})
recallBtn.addEventListener('click', recall)
modelBtn.addEventListener('click', () => modelPanel.classList.toggle('open'))
promptBtn.addEventListener('click', () => promptPanel.classList.toggle('open'))
toolsBtn.addEventListener('click', () => toolPanel.classList.toggle('open'))
inputEl.addEventListener('input', () => {
  if (!sending) syncSendButton()
})
cfgProvider.addEventListener('change', () => {
  const p = PROVIDER_PRESETS[cfgProvider.value]
  if (p) { cfgAiBase.value = p.base; cfgAiModel.value = p.model }
  cfgProvider.value = ''
})
modelSave.addEventListener('click', async () => {
  try {
    const settings = await api.saveSettings({
      aiKey: cfgAiKey.value.trim(),
      aiBaseUrl: cfgAiBase.value.trim() || 'https://api.anthropic.com',
      aiModel: cfgAiModel.value.trim() || 'claude-sonnet-4-5',
    })
    renderModelMeta(settings)
    modelFeedback.textContent = '已保存'
    setTimeout(() => { modelFeedback.textContent = '' }, 1600)
  } catch (err: any) {
    modelFeedback.textContent = err?.message || '保存失败'
    setTimeout(() => { modelFeedback.textContent = '' }, 2500)
  }
})
promptSave.addEventListener('click', async () => {
  await api.saveOfflinePrompt(promptInput.value)
  promptFeedback.textContent = '已保存'
  setTimeout(() => { promptFeedback.textContent = '' }, 1600)
})
toolSearch.addEventListener('input', renderTools)
imageViewerClose.addEventListener('click', closeImageViewer)
imageViewer.addEventListener('click', e => {
  if (e.target === imageViewer || e.target === imageViewerStage) closeImageViewer()
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && imageViewer.classList.contains('open')) closeImageViewer()
})
toolsAllBtn.addEventListener('click', () => {
  allowedTools = new Set(offlineToolDefs.map(t => t.name))
  renderTools()
})
toolsNoneBtn.addEventListener('click', () => {
  allowedTools.clear()
  renderTools()
})
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})
api.onOfflineChatProgress(applyProgress)

initOfflineChat().catch(err => {
  modelMeta.textContent = err?.message || String(err)
})
