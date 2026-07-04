// main — UI wiring for the phase-1 prototype. Replaces the Electron trio of
// main.ts (lifecycle) + ipc/* (bridge) + renderer.ts (UI): with the protocol
// already living in the WebView there is no IPC layer left, this file just
// binds the agent/executor modules to the DOM.

import './style.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { HeySureAgent, type DeviceStatus } from './agent'
import { login, pingServer, getMe } from './api'
import { initializeDynamicMcp } from './executor/dynamic'
import { getAllToolDefs } from './executor'
import { registerConfirmHandler, type ConfirmRequest } from './runtime/permission-guard'
import { probeRuntimes, type RuntimeReport } from './runtime/runtime-probe'
import { pauseExecution, resumeExecution, executionState } from './runtime/process'
import { native, type HostInfo } from './native'
import { loadSettings, saveSettings, ensureDeviceId, defaults, type AgentSettings } from './settings'

// Asset import via Vite so the logo is properly resolved in both dev and production
// without duplicating files from assets/ (single source of truth also used by Rust side).
import appLogoUrl from '../assets/desktop.png'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element #${id}`)
  return el as T
}

let settings: AgentSettings
let host: HostInfo
let agent: HeySureAgent | null = null
let paused = false
let totalCalls = 0
let successCalls = 0
let failedCalls = 0
let runningCalls = 0
let offlineMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
let offlineAllowedTools = new Set<string>()
let offlineAllowedToolsInitialized = false
let tokenTotals = { input: 0, output: 0, total: 0, estimated: false }

// Rich segments for conversation UI (synced with shared offline-chat.ts)
type Segment =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'think'; content: string }
  | { type: 'mcp'; tool: string; success: boolean; arguments: Record<string, any>; result: any; summary: string }

let segments: Segment[] = []
let liveToolEvents = 0
let liveAssistantIndex = -1
let liveThinkIndex = -1
let streamedThink = false
let sendingChat = false
let chatAbortController: AbortController | null = null
let cancelRequested = false

// ---------- activity log ----------

const MAX_LOG_LINES = 500

function appendLog(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  const log = $('log')
  const line = document.createElement('div')
  line.className = `log-line log-${level}`
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const extra = data !== undefined && data !== null && Object.keys(data).length
    ? ` ${JSON.stringify(data).slice(0, 200)}`
    : ''
  line.innerHTML = `<span class="t">${time}</span>`
  line.appendChild(document.createTextNode(`${message}${extra}`))
  log.appendChild(line)
  while (log.childElementCount > MAX_LOG_LINES) log.firstElementChild?.remove()
  log.scrollTop = log.scrollHeight
}

function updateStats() {
  $('stat-total').textContent = String(totalCalls)
  $('stat-success').textContent = String(successCalls)
  $('stat-failed').textContent = String(failedCalls)
  $('stat-running').textContent = String(runningCalls)
}

function resolveAvatarUrl(avatar: string, server: string): string {
  const raw = String(avatar || '').trim()
  if (!raw) return ''
  const base = String(server || '').replace(/\/+$/, '')
  const preset = raw.match(/avatars([1-5])(?:[-.][^/]*)?\.png/i)
  if (preset) return base ? `${base}/avatars/avatars${preset[1]}.png` : ''
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw
  if (!base) return raw
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`
}

async function fetchAvatarDataUrl(url: string): Promise<string> {
  if (!url || url.startsWith('data:')) return url
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('avatar read failed'))
    reader.readAsDataURL(blob)
  })
}

async function cacheAvatarIfPossible() {
  const url = resolveAvatarUrl(settings.userAvatar, settings.serverUrl)
  if (!url || url.startsWith('data:')) {
    settings.userAvatarDataUrl = url
    return
  }
  try {
    settings.userAvatarDataUrl = await fetchAvatarDataUrl(url)
    await saveSettings(settings)
  } catch (err) {
    console.warn('avatar cache failed:', err)
    settings.userAvatarDataUrl = ''
  }
}

// Keep avatar (and username) in sync with server-side changes (mirrors device/windows + shared
// logic in ipc/settings.ts which calls /api/auth/me on settings:get).
async function refreshUserProfile(): Promise<void> {
  if (!settings.authToken) return
  try {
    const me = await getMe(settings.serverUrl, settings.authToken)
    const freshAvatar = me && typeof me === 'object' ? String(me.avatar || '') : settings.userAvatar
    let changed = false
    if (freshAvatar !== settings.userAvatar) {
      settings.userAvatar = freshAvatar
      settings.userAvatarDataUrl = ''
      changed = true
    }
    const freshName = String((me && (me.name || me.nickname)) || settings.userName || settings.userAccount || '')
    if (freshName && freshName !== settings.userName) {
      settings.userName = freshName
      changed = true
    }
    if (changed || (settings.userAvatar && !settings.userAvatarDataUrl)) {
      if (settings.userAvatar) {
        await cacheAvatarIfPossible()
      } else {
        settings.userAvatarDataUrl = ''
      }
      await saveSettings(settings)
      renderAuthCards()
    } else if (settings.userAvatarDataUrl) {
      // Ensure UI reflects any dataUrl we already have
      renderAvatar()
    }
  } catch (err) {
    // best-effort only; fall back to cached/live URL
    if (settings.userAvatar && !settings.userAvatarDataUrl) {
      await cacheAvatarIfPossible().catch(() => {})
      renderAvatar()
    }
  }
}

// ---------- status chip ----------

const STATUS_LABEL: Record<DeviceStatus, [string, string]> = {
  disconnected: ['未连接', 'chip-gray'],
  connecting: ['连接中…', 'chip-yellow'],
  connected: ['已连接（注册中）', 'chip-yellow'],
  registered: ['已注册', 'chip-green'],
  error: ['错误', 'chip-red'],
}

function renderStatus(status: DeviceStatus, reason?: string, aiConfigId?: number | null) {
  const chip = $('status-chip')
  const dot = $('status-dot')
  const labelEl = $('status-label')
  let [label, cls] = STATUS_LABEL[status]
  if (status === 'registered') {
    label = aiConfigId == null ? '已注册（未分配 AI）' : `已注册 · AI #${aiConfigId}`
    cls = aiConfigId == null ? 'chip-yellow' : 'chip-green'
  }
  if (paused) {
    label += ' · 已暂停'
    cls = 'chip-orange'
  }
  labelEl.textContent = label
  dot.className = `status-dot ${cls.replace('chip-', '').replace('gray', 'red')}`
  chip.className = `status-pill ${cls === 'chip-orange' ? 'reconnecting' : ''}`
  chip.title = reason || ''
  $('info-status').textContent = label
  $('info-ai').textContent = aiConfigId == null ? '未分配' : `AI #${aiConfigId}`
  $('info-server').textContent = settings?.serverUrl || '—'
  $('info-workspace').textContent = settings?.workspaceRoot || '默认工作区'
  void native.setTrayStatus(status, paused).catch(() => {})
}

function renderReconnecting(active: boolean, reason?: string) {
  if (!active) return
  const chip = $('status-chip')
  $('status-label').textContent = reason || '正在重连…'
  $('status-dot').className = 'status-dot orange'
  chip.className = 'status-pill reconnecting'
  void native.setTrayStatus('connecting', paused).catch(() => {})
}

// ---------- permission confirm modal ----------

let confirmResolve: ((ok: boolean) => void) | null = null

function setupConfirmModal() {
  const settle = (ok: boolean) => {
    $('confirm-mask').classList.add('hidden')
    confirmResolve?.(ok)
    confirmResolve = null
  }
  $('btn-confirm-ok').addEventListener('click', () => settle(true))
  $('btn-confirm-no').addEventListener('click', () => settle(false))

  registerConfirmHandler(async (req: ConfirmRequest) => {
    // Surface the window: the confirm may arrive while we sit in the tray.
    const win = getCurrentWindow()
    await win.show().catch(() => {})
    await win.setFocus().catch(() => {})

    confirmResolve?.(false) // a newer request supersedes a stale one
    $('confirm-text').textContent =
      `工具 ${req.tool} 请求执行，需要以下权限：\n${req.reasons.join(', ')}` +
      (req.summary ? `\n\n说明：${req.summary}` : '')
    $('confirm-mask').classList.remove('hidden')
    return new Promise<boolean>(resolve => { confirmResolve = resolve })
  })
}

// ---------- tools ----------

function renderTools() {
  const defs = getAllToolDefs()
  $('tool-count').textContent = defs.length ? `${defs.length} 个工具` : ''
  const list = $('tool-list')
  list.innerHTML = ''
  const select = $<HTMLSelectElement>('test-tool')
  const selected = select.value
  select.innerHTML = ''

  if (defs.length === 0) {
    list.innerHTML = '<div class="empty-note">尚未加载 MCP 工具</div>'
  }

  const groups = [
    {
      zh: '服务器动态工具',
      en: 'Server Dynamic Tools',
      defs: defs.filter(def => (def.implementation as any)?.source === 'server'),
    },
    {
      zh: '本地动态工具',
      en: 'Local Dynamic Tools',
      defs: defs.filter(def => (def.implementation as any)?.source !== 'server' && (def.implementation as any)?.kind === 'dynamic'),
    },
    {
      zh: '内置工具',
      en: 'Built-in Tools',
      defs: defs.filter(def => (def.implementation as any)?.source !== 'server' && (def.implementation as any)?.kind !== 'dynamic'),
    },
  ].filter(group => group.defs.length > 0)

  for (const group of groups) {
    const details = document.createElement('details')
    details.className = 'mcp-parent'
    details.open = true

    const summary = document.createElement('summary')
    summary.innerHTML = `
      <span class="mcp-parent-summary-left">
        <span class="mcp-chevron"></span>
        <span class="mcp-parent-labels">
          <span class="mcp-parent-zh">${group.zh}</span>
          <span class="mcp-parent-en">${group.en}</span>
        </span>
      </span>
      <span class="mcp-parent-count">${group.defs.length} 个</span>
    `
    const body = document.createElement('div')
    body.className = 'mcp-parent-body'

    for (const def of group.defs) {
    const item = document.createElement('div')
    item.className = 'tool-item'

    const title = document.createElement('div')
    title.className = 'tool-title'

    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = def.name

    const sub = document.createElement('span')
    sub.className = 'tool-name-sub'
    sub.textContent = (def.implementation as any)?.source === 'server' ? 'Server Dynamic Tool'
      : (def.implementation as any)?.kind === 'dynamic' ? 'Local Dynamic Tool' : 'Built-in Tool'

    const desc = document.createElement('span')
    desc.className = 'tool-desc'
    desc.textContent = def.description
    desc.title = def.description

    const src = document.createElement('span')
    src.className = 'tool-src'
    src.textContent = (def.implementation as any)?.source === 'server' ? '服务器'
      : (def.implementation as any)?.kind === 'dynamic' ? '本地动态' : '内置'

    const top = document.createElement('div')
    top.className = 'tool-item-top'
    title.append(name, sub)
    top.append(title, src)
    item.append(top, desc)
      body.appendChild(item)

    const option = document.createElement('option')
    option.value = def.name
    option.textContent = def.name
    select.appendChild(option)
    }

    details.append(summary, body)
    list.appendChild(details)
  }
  if (selected && defs.some(d => d.name === selected)) select.value = selected
  renderOfflineTools()
}

async function runToolTest() {
  const tool = $<HTMLSelectElement>('test-tool').value
  if (!tool) return
  let args: Record<string, any>
  try {
    args = JSON.parse($<HTMLTextAreaElement>('test-args').value || '{}')
  } catch {
    showTestResult({ error: '参数不是合法 JSON' })
    return
  }
  const btn = $<HTMLButtonElement>('btn-test-run')
  btn.disabled = true
  totalCalls += 1
  runningCalls += 1
  updateStats()
  try {
    const runner = agent || new HeySureAgent(settings, host)
    appendLog('info', `本地测试 ${tool}`, args)
    const outcome = await runner.runToolLocally(tool, args)
    showTestResult(outcome)
    if (outcome.success) successCalls += 1
    else failedCalls += 1
    appendLog(outcome.success ? 'info' : 'warn', `本地测试 ${tool} ${outcome.success ? '完成' : '失败'}: ${outcome.summary}`)
  } catch (err: any) {
    failedCalls += 1
    showTestResult({ error: err?.message || String(err) })
  } finally {
    runningCalls = Math.max(0, runningCalls - 1)
    updateStats()
    btn.disabled = false
  }
}

function showTestResult(value: any) {
  const box = $('test-result')
  box.classList.remove('hidden')
  box.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function updateTokenStats(usage?: any) {
  if (usage) {
    const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0)
    const output = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0)
    const total = Number(usage.total_tokens ?? usage.totalTokens ?? input + output)
    tokenTotals.input += input
    tokenTotals.output += output
    tokenTotals.total += total
    if (usage.estimated) tokenTotals.estimated = true
  }
  const suffix = tokenTotals.estimated ? '（含估算）' : ''
  $('offline-token-stats').textContent = `本次会话累计 Token：输入 ${tokenTotals.input} / 输出 ${tokenTotals.output} / 总计 ${tokenTotals.total}${suffix}`
}

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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

function renderOfflineChat() {
  const log = $('chat-log')
  log.innerHTML = ''
  if (!segments.length && offlineMessages.length) {
    // Hydrate display from history (e.g. after reload of webview)
    for (const m of offlineMessages) {
      segments.push({ type: 'message', role: m.role as any, content: m.content })
    }
  }
  if (!segments.length) {
    const empty = document.createElement('div')
    empty.className = 'offline-msg system'
    empty.textContent = '输入消息后，AI 会直接使用本机模型配置，并可调用本机 MCP 工具。'
    log.appendChild(empty)
  }
  for (const item of segments) {
    if (item.type === 'message') {
      const el = document.createElement('div')
      el.className = `offline-msg ${item.role}`
      el.innerHTML = escapeHtml(item.content).replace(/\n/g, '<br>')
      log.appendChild(el)
    } else if (item.type === 'think') {
      if (!item.content.trim()) continue
      const el = detailsSegment('深度思考', item.content, true)
      el.classList.add('think')
      log.appendChild(el)
    } else {
      const status = item.summary === '执行中...' ? '执行中' : (item.success ? '成功' : '失败')
      log.appendChild(mcpSegmentWithImages(item, status))
    }
  }
  log.scrollTop = log.scrollHeight
  // also update token in case
  const recall = document.getElementById('offline-recall-btn') as HTMLButtonElement | null
  if (recall) recall.disabled = sendingChat || segments.length === 0
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
  renderOfflineChat()
}

function appendTextDelta(text: string) {
  const delta = String(text || '')
  if (!delta) return
  const idx = ensureLiveAssistantSegment()
  ;(segments[idx] as any).content += delta
  renderOfflineChat()
}

function offlineSafeStringify(value: any): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function isImageDataUrl(value: any): boolean {
  return typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(String(value).trim())
}

function collectToolImages(value: any, tool: string, path = 'result', seen = new Set<any>()): Array<{ label: string; url: string }> {
  if (value == null) return []
  if (typeof value === 'object') {
    if (seen.has(value)) return []
    seen.add(value)
  }
  if (isImageDataUrl(value)) return [{ label: /capture|screenshot/i.test(tool) ? '截图' : '图片', url: String(value).trim() }]
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

function mcpSegmentWithImages(item: Extract<Segment, { type: 'mcp' }>, status: string): HTMLElement {
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
  // simple inline images (clickable to new window / data)
  const imgStrip = document.createElement('div')
  imgStrip.style.display = 'grid'
  imgStrip.style.gridTemplateColumns = 'repeat(auto-fit, minmax(140px, 1fr))'
  imgStrip.style.gap = '6px'
  imgStrip.style.marginTop = '4px'
  for (const img of images.slice(0, 4)) {
    const fig = document.createElement('figure')
    fig.style.margin = '0'
    fig.style.border = '1px solid var(--border)'
    fig.style.borderRadius = '4px'
    fig.style.overflow = 'hidden'
    const b = document.createElement('button')
    b.style.border = '0'
    b.style.padding = '0'
    b.style.background = 'transparent'
    b.style.cursor = 'pointer'
    const im = document.createElement('img')
    im.src = img.url
    im.style.width = '100%'
    im.style.maxHeight = '140px'
    im.style.objectFit = 'contain'
    im.style.background = '#0b1220'
    b.appendChild(im)
    b.addEventListener('click', () => {
      // open in new tab / window for preview
      const w = window.open('', '_blank')
      if (w) {
        w.document.write(`<title>${img.label}</title><img src="${img.url}" style="max-width:100%;background:#111827"/>`)
      }
    })
    fig.appendChild(b)
    imgStrip.appendChild(fig)
  }
  if (imgStrip.childElementCount) wrap.appendChild(imgStrip)
  return wrap
}

function insertMcpEvent(tool: string, args: any, result: any, success: boolean, summary: string) {
  segments.push({ type: 'mcp', tool, success, arguments: args || {}, result, summary })
  liveToolEvents++
  renderOfflineChat()
}

function appendMessage(role: 'user' | 'assistant', content: string) {
  segments.push({ type: 'message', role, content })
  renderOfflineChat()
}

function buildEndpoint(baseUrl: string, anthropic: boolean): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (anthropic) {
    return /\/v1\/messages$/i.test(base) ? base : `${base}/v1/messages`
  }
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/(?:v1|api\/v\d+)$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function providerToolName(name: string, nameMap: Map<string, string>): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '__')
  nameMap.set(safe, name)
  return safe
}

function toProviderMessages(msgs: any[], isAnthropic: boolean, _nameMap: Map<string, string>): any[] {
  if (isAnthropic) {
    return msgs.map(m => ({ role: m.role, content: m.content }));
  }
  // Convert internal (Anthropic-style blocks) to OpenAI chat format
  const out: any[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const toolUses = m.content.filter((b: any) => b && b.type === 'tool_use');
      if (toolUses.length) {
        const toolCalls = toolUses.map((tu: any) => {
          const safeName = (tu.name || '').replace(/[^a-zA-Z0-9_-]/g, '__');
          return {
            id: tu.id,
            type: 'function',
            function: {
              name: safeName,
              arguments: JSON.stringify(tu.input || {}),
            },
          };
        });
        out.push({ role: 'assistant', content: null, tool_calls: toolCalls });
        continue;
      }
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const hasToolResult = m.content.some((b: any) => b && b.type === 'tool_result');
      if (hasToolResult) {
        for (const tr of m.content) {
          if (tr && tr.type === 'tool_result') {
            out.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id || 'call_0',
              content: offlineSafeStringify(tr.content),
            });
          } else if (tr && tr.type === 'text' && tr.text) {
            out.push({ role: 'user', content: tr.text });
          }
        }
        continue;
      }
    }
    // normal message (string content or other)
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function normalizeUsage(raw: any): any | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw.input_tokens ?? raw.prompt_tokens ?? 0
  const output = raw.output_tokens ?? raw.completion_tokens ?? 0
  const total = raw.total_tokens ?? (Number(input) + Number(output))
  return { input_tokens: Number(input), output_tokens: Number(output), total_tokens: Number(total) }
}

async function streamOpenAIResponse(
  res: Response,
  nameMap: Map<string, string>,
  onDelta: (type: 'text' | 'think' | 'tool', payload: any) => void,
  signal?: AbortSignal
): Promise<{ text: string; think?: string; toolUses?: any[]; usage?: any }> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('AI API did not return a readable stream')
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let think = ''
  let usage: any = null
  const calls = new Map<number, { id: string; name: string; arguments: string }>()

  const handle = (payload: string) => {
    const raw = payload.trim()
    if (!raw || raw === '[DONE]') return
    let data: any
    try { data = JSON.parse(raw) } catch { return }
    if (data.usage) usage = normalizeUsage(data.usage) || usage
    const delta = data.choices?.[0]?.delta || {}
    const reasoning = delta.reasoning_content || delta.reasoning || delta.reasoning_text
    if (reasoning) {
      think += String(reasoning)
      onDelta('think', String(reasoning))
    }
    if (delta.content) {
      text += String(delta.content)
      onDelta('text', String(delta.content))
    }
    for (const tc of delta.tool_calls || []) {
      const idx = Number.isFinite(tc.index) ? tc.index : calls.size
      const cur = calls.get(idx) || { id: '', name: '', arguments: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += String(tc.function.name)
      if (tc.function?.arguments) cur.arguments += String(tc.function.arguments)
      calls.set(idx, cur)
    }
  }

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const t = line.trim()
        if (t.startsWith('data:')) handle(t.slice(5))
      }
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      const t = line.trim()
      if (t.startsWith('data:')) handle(t.slice(5))
    }
  }

  const toolUses = Array.from(calls.values())
    .filter(tc => tc.name)
    .map((tc, idx) => ({
      type: 'tool_use' as const,
      id: tc.id || `call_${idx}`,
      name: (nameMap.get(tc.name) || tc.name),
      input: (() => { try { return JSON.parse(tc.arguments || '{}') } catch { return {} } })(),
    }))
  return { text, think: think.trim() || undefined, toolUses: toolUses.length ? toolUses : undefined, usage }
}

async function callLocalModelWithTools(
  allowedTools: string[],
  onProgress?: (ev: { type: string; text?: string; tool?: string; arguments?: any; event?: any }) => void
): Promise<{ text: string; think?: string; usage?: any; toolEvents?: Array<any> }> {
  const baseUrl = String(settings.aiBaseUrl || '').trim()
  const apiKey = String(settings.aiKey || '').trim()
  const model = String(settings.aiModel || '').trim()
  if (!apiKey) throw new Error('未配置 AI Key')
  if (!baseUrl) throw new Error('未配置 Base URL')
  if (!model) throw new Error('未配置模型')

  const isAnthropic = /anthropic/i.test(baseUrl)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const endpoint = buildEndpoint(baseUrl, isAnthropic)
  const basePrompt = String(settings.offlinePrompt || '').trim()
  const effectiveBase = basePrompt || '你是 HeySure AI，运行在 Windows 桌面端的本地对话窗口中。你可以直接回答用户，也可以调用本机 MCP 工具完成文件、窗口、键鼠、剪贴板、终端等桌面任务。需要操作电脑时优先使用工具，并用和用户相同的语言回复。'

  // Only mention vision coordinate rules if the user has actually selected vision-related tools
  const hasVisionTools = (allowedTools || []).some((t: string) => /vision|capture|screenshot|screen/i.test(t))
  const visionRule = hasVisionTools
    ? '\n\n坐标规则：当你根据 vision.capture / vision.capture_mouse 的截图调用 mouse.* 工具时，x/y 使用返回截图内容左上角为原点的像素坐标；不要使用 0-1000 归一化坐标。'
    : ''

  const systemPrompt = effectiveBase + visionRule
  let currentMessages: any[] = [...offlineMessages]

  const nameMap = new Map<string, string>()
  const toolDefs = getAllToolDefs().filter(d => new Set(allowedTools).has(d.name))
  const toolList = toolDefs.map(d => {
    const safeName = providerToolName(d.name, nameMap)
    return isAnthropic
      ? { name: safeName, description: d.description, input_schema: d.input_schema || { type: 'object', properties: {} } }
      : { type: 'function', function: { name: safeName, description: d.description, parameters: d.input_schema || { type: 'object', properties: {} } } }
  })

  const toolEvents: any[] = []
  let finalText = ''
  let finalThink: string | undefined
  let usage: any = null
  const maxTurns = 10

  const execTool = async (tname: string, targs: any) => {
    insertMcpEvent(tname, targs, null, true, '执行中...')
    let execResult: any = { success: false, result: '工具未找到' }
    try {
      const runner = agent || new HeySureAgent(settings, host)
      execResult = await (runner as any).runToolLocally?.(tname, targs) || { success: false, result: 'no runner' }
    } catch (e: any) {
      execResult = { success: false, result: String(e?.message || e) }
    }
    const summary = execResult.success ? '成功' : '失败'
    const last = segments[segments.length - 1]
    if (last && last.type === 'mcp' && last.tool === tname && last.summary === '执行中...') {
      last.result = execResult.result ?? execResult
      last.success = !!execResult.success
      last.summary = summary
      renderOfflineChat()
    } else {
      insertMcpEvent(tname, targs, execResult.result ?? execResult, !!execResult.success, summary)
    }
    toolEvents.push({ tool: tname, arguments: targs, success: !!execResult.success, result: execResult.result ?? execResult, summary })
    return execResult
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (chatAbortController?.signal.aborted) break

    const outgoingMessages = toProviderMessages(currentMessages, isAnthropic, nameMap);
    const body: any = isAnthropic
      ? {
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: outgoingMessages,
          ...(toolList.length ? { tools: toolList } : {}),
        }
      : {
          model,
          max_tokens: 4096,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'system', content: systemPrompt }, ...outgoingMessages],
          ...(toolList.length ? { tools: toolList } : {}),
        }

    const fetchRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: chatAbortController ? chatAbortController.signal : AbortSignal.timeout(180_000),
    })

    if (!fetchRes.ok) {
      const errData = await fetchRes.json().catch(async () => ({ error: await fetchRes.text().catch(() => '') }))
      const detail = errData?.error?.message || errData?.detail || errData?.error || `HTTP ${fetchRes.status}`
      throw new Error(String(detail))
    }

    let respText = ''
    let respThink: string | undefined
    let respToolUses: any[] = []
    let respUsage: any = null

    if (!isAnthropic) {
      const streamed = await streamOpenAIResponse(fetchRes, nameMap, (type, payload) => {
        if (type === 'text') {
          onProgress?.({ type: 'text_delta', text: payload })
          appendTextDelta(payload)
        } else if (type === 'think') {
          onProgress?.({ type: 'think_delta', text: payload })
          appendThinkDelta(payload)
        }
      }, chatAbortController?.signal)
      respText = streamed.text || ''
      respThink = streamed.think
      respToolUses = streamed.toolUses || []
      respUsage = streamed.usage
    } else {
      // Anthropic non-stream (or could add stream later)
      const data: any = await fetchRes.json().catch(() => ({}))
      const blocks = Array.isArray(data.content) ? data.content : []
      respText = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n').trim()
      respToolUses = (data.content || [])
        .filter((b: any) => b.type === 'tool_use')
        .map((tu: any) => ({ ...tu, name: (nameMap.get(tu.name) || tu.name) }))
      respUsage = normalizeUsage(data.usage)
      if (respText) onProgress?.({ type: 'text_delta', text: respText })
    }

    usage = respUsage || usage
    if (respThink) finalThink = respThink

    if (!respToolUses.length) {
      finalText = respText || '完成'
      break
    }

    // process tools
    currentMessages.push({ role: 'assistant', content: respToolUses })
    const toolResults: any[] = []
    for (const tu of respToolUses) {
      if (chatAbortController?.signal.aborted) break
      const origName = (nameMap.get(tu.name) || tu.name)
      const r = await execTool(origName, tu.input || {})
      const content = r?.success ? r.result : `Error: ${r?.summary || '工具执行失败'}`
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: !r?.success })
    }
    currentMessages.push({ role: 'user', content: toolResults })
  }

  return { text: finalText || '完成', think: finalThink, usage, toolEvents }
}

async function sendLocalChat() {
  const input = $<HTMLTextAreaElement>('chat-input')
  const text = input.value.trim()
  if (!text || sendingChat) return

  appendMessage('user', text)
  offlineMessages.push({ role: 'user', content: text })
  input.value = ''

  const btn = $<HTMLButtonElement>('btn-chat-send')
  sendingChat = true
  liveAssistantIndex = -1
  liveThinkIndex = -1
  liveToolEvents = 0
  streamedThink = false
  cancelRequested = false
  chatAbortController = new AbortController()
  btn.disabled = false
  btn.textContent = '停止'
  btn.classList.add('stop')

  try {
    const allowed = Array.from(offlineAllowedTools)
    const result = await callLocalModelWithTools(allowed, (ev) => {
      // progress can be used for future server-like events
      if (ev.type === 'tool_start') {
        // already handled inside via insert
      }
    })

    if (!cancelRequested) {
      if (result.think && !streamedThink) {
        // append final think if not streamed
        if (!segments.some(s => s.type === 'think' && s.content.includes(result.think || ''))) {
          segments.push({ type: 'think', content: result.think || '' })
        }
      }
      let assistantText = result.text || ''
      if (liveAssistantIndex >= 0 && segments[liveAssistantIndex]?.type === 'message') {
        assistantText = (segments[liveAssistantIndex] as any).content || assistantText
      } else if (assistantText) {
        appendMessage('assistant', assistantText)
      }
      // ensure offlineMessages has the final assistant turn for next context
      if (assistantText && (offlineMessages.length === 0 || offlineMessages[offlineMessages.length-1]?.role !== 'assistant')) {
        offlineMessages.push({ role: 'assistant', content: assistantText })
      }
      updateTokenStats(result.usage)
    }
  } catch (err: any) {
    if (!cancelRequested && !(err && (err.name === 'AbortError' || /aborted|cancel/i.test(String(err))))) {
      appendMessage('assistant', `本地对话失败：${err?.message || err}`)
    }
  } finally {
    sendingChat = false
    chatAbortController = null
    btn.disabled = false
    btn.textContent = '发送'
    btn.classList.remove('stop')
    renderOfflineChat()
  }
}

async function stopLocalChat() {
  if (!sendingChat) return
  cancelRequested = true
  if (chatAbortController) {
    chatAbortController.abort()
  }
  try {
    // no IPC cancel needed in tauri, abort is sufficient
  } finally {
    // sendLocalChat finally will clean up UI
  }
}

function renderOfflineMeta() {
  const model = settings.aiModel?.trim() || '未配置模型'
  const base = settings.aiBaseUrl?.trim() || '未配置 Base URL'
  const keySuffix = settings.aiKey ? '' : ' · 未配置 AI Key'
  $('offline-model-meta').textContent = `${model} · ${base}${keySuffix}`
}

function renderOfflineTools() {
  const defs = getAllToolDefs()
  const keyword = ($<HTMLInputElement>('offline-tool-search')?.value || '').trim().toLowerCase()
  if (!offlineAllowedToolsInitialized && offlineAllowedTools.size === 0 && defs.length) {
    offlineAllowedTools = new Set(defs.map(def => def.name))
    offlineAllowedToolsInitialized = true
  }
  $('offline-tool-count').textContent = `本次对话可用 ${offlineAllowedTools.size}/${defs.length} 个 MCP 工具`
  const list = $('offline-tool-list')
  list.innerHTML = ''
  for (const def of defs.filter(def => !keyword || def.name.toLowerCase().includes(keyword) || String(def.description || '').toLowerCase().includes(keyword))) {
    const label = document.createElement('label')
    label.className = 'offline-tool-item'
    label.title = def.description || def.name
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = offlineAllowedTools.has(def.name)
    cb.addEventListener('change', () => {
      if (cb.checked) offlineAllowedTools.add(def.name)
      else offlineAllowedTools.delete(def.name)
      renderOfflineTools()
    })
    const span = document.createElement('span')
    span.textContent = def.name
    label.append(cb, span)
    list.appendChild(label)
  }
}

// ---------- runtimes ----------

function renderRuntimes(report: RuntimeReport | null) {
  const fmt = (info: { available: boolean; version: string } | undefined) =>
    !info ? '未探测' : info.available ? (info.version || '可用') : '不可用'
  $('rt-powershell').textContent = fmt(report?.powershell)
  $('rt-shell').textContent = fmt(report?.shell)
}

async function probe(force: boolean) {
  renderRuntimes(await probeRuntimes(force))
}

// ---------- agent lifecycle ----------

function buildAgent(): HeySureAgent {
  return new HeySureAgent(settings, host, {
    onStatusChange: renderStatus,
    onReconnecting: renderReconnecting,
    onLog: appendLog,
    onTaskStart: () => {
      totalCalls += 1
      runningCalls += 1
      updateStats()
    },
    onTaskResult: (_taskId, _tool, _result, success) => {
      runningCalls = Math.max(0, runningCalls - 1)
      if (success) successCalls += 1
      else failedCalls += 1
      updateStats()
    },
    onAuthFailure: (reason) => void recoverAuth(reason),
  })
}

// Silent re-login with saved credentials when the server rejects our token
// (port of services/reauth.ts, simplified: one attempt per rejection).
async function recoverAuth(reason: string) {
  if (!settings.rememberLogin || !settings.userAccount || !settings.userPassword) {
    appendLog('warn', `登录态失效（${reason}），请手动重新登录`)
    return
  }
  appendLog('info', '登录态失效，正在用保存的凭据重新登录…')
  try {
    const result = await login(settings.serverUrl, settings.userAccount, settings.userPassword)
    settings.authToken = result.accessToken
    settings.agentSocketUrl = result.agentSocketUrl
    settings.userName = String(result.user?.name || result.user?.nickname || settings.userAccount)
    settings.userAvatar = String(result.user?.avatar || '')
    settings.userAvatarDataUrl = ''
    await cacheAvatarIfPossible()
    settings.userId = (result.user?.id as number | undefined) ?? null
    await saveSettings(settings)
    agent?.updateSettings(settings)
    renderAuthCards()
    appendLog('info', '已自动恢复登录')
  } catch (err: any) {
    appendLog('error', `自动重新登录失败: ${err?.message || err}`)
  }
}

function renderAuthCards() {
  const loggedIn = !!settings.authToken
  $('login-form').classList.toggle('hidden', loggedIn)
  $('logged-in').classList.toggle('hidden', !loggedIn)
  $('header-user-name').textContent = loggedIn ? (settings.userName || settings.userAccount) : '未登录'
  if (loggedIn) {
    $('lbl-user').textContent = settings.userName || settings.userAccount
    $('lbl-server').textContent = settings.serverUrl
  }
  renderAvatar()
}

function avatarSrc(): string {
  if (settings.userAvatarDataUrl) return settings.userAvatarDataUrl
  return resolveAvatarUrl(settings.userAvatar, settings.serverUrl)
}

function bindAvatar(imgEl: HTMLImageElement, container: HTMLElement, src: string, fallback: string, textEl: HTMLElement) {
  textEl.textContent = fallback
  container.classList.remove('has-image')
  imgEl.onload = null
  imgEl.onerror = null
  if (!src) {
    imgEl.removeAttribute('src')
    return
  }
  imgEl.onload = () => container.classList.add('has-image')
  imgEl.onerror = () => container.classList.remove('has-image')
  imgEl.src = src
}

function renderAvatar() {
  const loggedIn = !!settings.authToken
  const shown = String(settings.userName || settings.userAccount || '').trim()
  const initial = shown ? shown.slice(0, 1).toUpperCase() : '·'
  const src = loggedIn && shown ? avatarSrc() : ''
  const avatar = src

  bindAvatar($<HTMLImageElement>('header-user-ava-img'), $('header-user-ava'), avatar, initial, $('header-user-ava-text'))
  bindAvatar($<HTMLImageElement>('account-info-ava-img'), $('account-info-ava'), avatar, initial, $('account-info-ava-text'))
}

async function doLogin() {
  const btn = $<HTMLButtonElement>('btn-login')
  const msg = $('login-msg')
  const serverUrl = $<HTMLInputElement>('in-server').value.trim()
  const account = $<HTMLInputElement>('in-account').value.trim()
  const password = $<HTMLInputElement>('in-password').value
  const remember = $<HTMLInputElement>('in-remember').checked
  btn.disabled = true
  msg.className = 'hint'
  msg.textContent = '登录中…'
  try {
    const result = await login(serverUrl, account, password)
    settings.serverUrl = serverUrl
    settings.agentSocketUrl = result.agentSocketUrl
    settings.authToken = result.accessToken
    settings.userAccount = account
    settings.userPassword = remember ? password : ''
    settings.rememberLogin = remember
    settings.userName = String(result.user?.name || result.user?.nickname || account)
    settings.userAvatar = String(result.user?.avatar || '')
    settings.userAvatarDataUrl = ''
    await cacheAvatarIfPossible()
    settings.userId = (result.user?.id as number | undefined) ?? null
    await saveSettings(settings)
    msg.className = 'hint ok'
    msg.textContent = '登录成功'
    appendLog('info', `已登录 ${settings.userName}`)
    renderAuthCards()
    if (agent) agent.updateSettings(settings)
    else { agent = buildAgent(); agent.connect() }
  } catch (err: any) {
    msg.className = 'hint error'
    msg.textContent = err?.message || String(err)
  } finally {
    btn.disabled = false
  }
}

async function doLogout() {
  agent?.disconnect()
  settings.authToken = ''
  settings.agentSocketUrl = ''
  settings.userName = ''
  settings.userAvatar = ''
  settings.userAvatarDataUrl = ''
  settings.userId = null
  if (!settings.rememberLogin) {
    settings.userAccount = ''
    settings.userPassword = ''
  }
  await saveSettings(settings)
  agent = null
  renderAuthCards()
  renderStatus('disconnected')
  appendLog('info', '已退出登录')
}

async function doPing() {
  const msg = $('login-msg')
  msg.className = 'hint'
  msg.textContent = '测试中…'
  const result = await pingServer($<HTMLInputElement>('in-server').value)
  if (result.success) {
    msg.className = 'hint ok'
    msg.textContent = `服务器可达（HTTP ${result.status}，${result.ms}ms）`
  } else {
    msg.className = 'hint error'
    msg.textContent = result.error
  }
}

async function doSaveSettings() {
  settings.serverUrl = $<HTMLInputElement>('in-server').value.trim()
  settings.agentName = $<HTMLInputElement>('in-agent-name').value.trim() || settings.agentName
  settings.agentGroup = $<HTMLInputElement>('in-agent-group').value.trim()
  settings.workspaceRoot = $<HTMLInputElement>('in-workspace').value.trim()
  settings.mouseFx = $<HTMLInputElement>('cfg-mouse-fx').checked
  settings.mouseCoordinateScaleX = Number($<HTMLInputElement>('cfg-mouse-scale-x').value) || 1
  settings.mouseCoordinateScaleY = Number($<HTMLInputElement>('cfg-mouse-scale-y').value) || 1
  if (settings.workspaceRoot) {
    try { await native.ensureDir(settings.workspaceRoot) } catch (err: any) {
      appendLog('error', `工作目录不可用: ${err?.message || err}`)
      return
    }
  }
  await saveSettings(settings)
  const fb = $('save-feedback')
  fb.className = 'save-feedback ok'
  fb.textContent = '已保存 ✓'
  setTimeout(() => { fb.textContent = '' }, 2000)
  appendLog('info', '设置已保存')
  agent?.updateSettings(settings)
  renderStatus(agent?.status || 'disconnected', undefined, agent?.boundAiConfigId)
}

async function togglePause() {
  const btn = $<HTMLButtonElement>('btn-pause')
  if (paused) {
    await resumeExecution()
    paused = false
    btn.textContent = '暂停执行'
    appendLog('info', '已恢复远程执行')
  } else {
    const killed = await pauseExecution()
    paused = true
    btn.textContent = '恢复执行'
    appendLog('warn', `已暂停远程执行（终止了 ${killed} 个进程）`)
  }
  renderStatus(agent?.status || 'disconnected', undefined, agent?.boundAiConfigId)
}

// ---------- shell UI ----------

function openModal(id: string) {
  $(id).classList.remove('hidden')
}

function closeModal(id: string) {
  $(id).classList.add('hidden')
}

function setupShellUi() {
  $('header-user-chip').addEventListener('click', () => {
    if (settings.authToken) {
      void refreshUserProfile().finally(() => openModal('login-modal'))
    } else {
      openModal('login-modal')
    }
  })
  $('settings-btn').addEventListener('click', () => openModal('settings-modal'))
  $('status-chip').addEventListener('click', () => openModal('members-modal'))
  $('tool-test-open').addEventListener('click', () => openModal('tool-test-modal'))
  $('settings-close').addEventListener('click', () => closeModal('settings-modal'))
  $('members-modal-close').addEventListener('click', () => closeModal('members-modal'))
  $('login-modal-close').addEventListener('click', () => closeModal('login-modal'))
  $('tool-test-close').addEventListener('click', () => closeModal('tool-test-modal'))
  $('theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('light')
    document.documentElement.classList.toggle('light')
    const light = document.body.classList.contains('light')
    $('theme-toggle').textContent = light ? '☀' : '🌙'
    settings.theme = light ? 'light' : 'dark'
    void saveSettings(settings)
  })

  void setupWindowControls()
  $('btn-disconnect').addEventListener('click', () => {
    agent?.disconnect()
    renderStatus('disconnected')
  })
  $('calibrate-mouse-btn').addEventListener('click', () => {
    const fb = $('calibrate-feedback')
    fb.className = 'save-feedback error'
    fb.textContent = 'Tauri 轻量版暂未迁移截图与键鼠注入，无法自动校准'
    setTimeout(() => { fb.textContent = '' }, 4500)
  })
  $('btn-chat-send').addEventListener('click', () => {
    if (sendingChat) void stopLocalChat()
    else void sendLocalChat()
  })
  $('chat-input').addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (sendingChat) void stopLocalChat()
      else void sendLocalChat()
    }
  })
  $('chat-input').addEventListener('input', () => {
    const btn = $<HTMLButtonElement>('btn-chat-send')
    if (!sendingChat) {
      btn.disabled = !$<HTMLTextAreaElement>('chat-input').value.trim()
    }
  })
  $('offline-model-btn').addEventListener('click', () => $('offline-model-panel').classList.toggle('open'))
  $('offline-prompt-btn').addEventListener('click', () => {
    const panel = $('offline-prompt-panel')
    panel.classList.toggle('open')
    if (panel.classList.contains('open')) {
      const ta = $<HTMLTextAreaElement>('offline-prompt-input')
      if (!ta.value || !ta.value.trim()) {
        ta.value = defaults.offlinePrompt || ''
      }
    }
  })
  $('offline-tools-btn').addEventListener('click', () => {
    const panel = $('offline-tool-panel')
    panel.classList.toggle('open')
    if (panel.classList.contains('open')) {
      renderOfflineTools()
    }
  })
  $('offline-recall-btn').addEventListener('click', () => {
    if (sendingChat || !offlineMessages.length) return
    if (offlineMessages[offlineMessages.length - 1]?.role === 'assistant') offlineMessages.pop()
    if (offlineMessages[offlineMessages.length - 1]?.role === 'user') offlineMessages.pop()
    const lastUser = segments.map((s, i) => (s.type === 'message' && s.role === 'user') ? i : -1).filter(i => i >= 0).pop()
    if (typeof lastUser === 'number') {
      segments = segments.slice(0, lastUser)
    } else {
      segments = []
    }
    renderOfflineChat()
  })
  const providerSel = document.getElementById('cfg-ai-provider') as HTMLSelectElement | null
  if (providerSel) {
    const PROVIDER_PRESETS: Record<string, { base: string; model: string }> = {
      anthropic:  { base: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
      openai:     { base: 'https://api.openai.com',    model: 'gpt-4o' },
      deepseek:   { base: 'https://api.deepseek.com',  model: 'deepseek-chat' },
      openrouter: { base: 'https://openrouter.ai/api', model: 'anthropic/claude-3.5-sonnet' },
      ollama:     { base: 'http://localhost:11434',    model: 'llama3.1' },
    }
    providerSel.addEventListener('change', () => {
      const p = PROVIDER_PRESETS[providerSel.value]
      if (p) {
        $<HTMLInputElement>('cfg-ai-base').value = p.base
        $<HTMLInputElement>('cfg-ai-model').value = p.model
      }
      providerSel.value = ''
    })
  }

  $('offline-model-save').addEventListener('click', async () => {
    settings.aiKey = $<HTMLInputElement>('cfg-ai-key').value
    settings.aiBaseUrl = $<HTMLInputElement>('cfg-ai-base').value.trim()
    settings.aiModel = $<HTMLInputElement>('cfg-ai-model').value.trim()
    await saveSettings(settings)
    renderOfflineMeta()
    const fb = $('offline-model-feedback')
    fb.className = 'save-feedback ok'
    fb.textContent = '已保存 ✓'
    setTimeout(() => { fb.textContent = '' }, 2000)
  })
  $('offline-prompt-save').addEventListener('click', async () => {
    settings.offlinePrompt = $<HTMLTextAreaElement>('offline-prompt-input').value.trim()
    await saveSettings(settings)
    const fb = $('offline-prompt-feedback')
    fb.className = 'save-feedback ok'
    fb.textContent = '已保存 ✓'
    setTimeout(() => { fb.textContent = '' }, 2000)
  })
  $('offline-tool-search').addEventListener('input', renderOfflineTools)
  $('offline-tools-all').addEventListener('click', () => {
    offlineAllowedTools = new Set(getAllToolDefs().map(def => def.name))
    renderOfflineTools()
  })
  $('offline-tools-none').addEventListener('click', () => {
    offlineAllowedTools.clear()
    renderOfflineTools()
  })

  // Also ensure that if tools are loaded async via callback, we re-render the offline list
  // (the init logic inside renderOfflineTools will handle first population if needed)
}

// ---------- window controls (frameless) ----------

const appWindow = getCurrentWindow()

function syncWindowMaxButton(isMaximized: boolean) {
  const maxBtn = $('window-max-btn') as HTMLButtonElement
  maxBtn.classList.toggle('restore', isMaximized)
  maxBtn.classList.toggle('max', !isMaximized)
  maxBtn.title = isMaximized ? '还原' : '最大化'
  maxBtn.setAttribute('aria-label', isMaximized ? '还原' : '最大化')
}

async function setupWindowControls() {
  const minBtn = $('window-min-btn') as HTMLButtonElement
  const maxBtn = $('window-max-btn') as HTMLButtonElement
  const closeBtn = $('window-close-btn') as HTMLButtonElement

  minBtn.addEventListener('click', () => {
    void appWindow.minimize()
  })

  maxBtn.addEventListener('click', async () => {
    await appWindow.toggleMaximize()
    const isMax = await appWindow.isMaximized()
    syncWindowMaxButton(isMax)
  })

  closeBtn.addEventListener('click', () => {
    void appWindow.close()
  })

  // initial state
  try {
    const isMax = await appWindow.isMaximized()
    syncWindowMaxButton(isMax)
  } catch {}

  // listen to resize (covers maximize/restore on Windows)
  await appWindow.listen('tauri://resize', async () => {
    try {
      const isMax = await appWindow.isMaximized()
      syncWindowMaxButton(isMax)
    } catch {}
  })
}

// ---------- boot ----------

async function boot() {
  host = await native.hostInfo()
  settings = await loadSettings()
  await ensureDeviceId(settings)
  document.body.classList.toggle('light', settings.theme === 'light')
  document.documentElement.classList.toggle('light', settings.theme === 'light')
  // No toolEnabled provider (MCP checkboxes removed; server issues all tools)

  // Set the header logo from the imported asset (avoids duplication with assets/ used by Rust).
  const logoEl = document.querySelector<HTMLImageElement>('.app-logo')
  if (logoEl) logoEl.src = appLogoUrl
  setupConfirmModal()
  setupShellUi()

  // Wire tray context menu actions emitted from Rust (to keep tray menu
  // behavior identical to the Electron windows/ version).
  void listen('tray:toggle-connect', () => {
    if (!agent) return
    const s = agent.status || 'disconnected'
    const active = s === 'connected' || s === 'registered'
    if (active) {
      agent.disconnect()
    } else {
      agent.connect()
    }
  })
  void listen('tray:pause-toggled', async () => {
    try {
      const st = await executionState()
      paused = st.paused
      const btn = $<HTMLButtonElement>('btn-pause')
      if (btn) btn.textContent = paused ? '恢复执行' : '暂停执行'
      renderStatus(agent?.status || 'disconnected', undefined, agent?.boundAiConfigId)
    } catch {}
  })

  try {
    await initializeDynamicMcp(() => {
      renderTools()
      agent?.refreshRegistration()
    })
  } catch (err: any) {
    appendLog('error', `本地动态 MCP 加载失败: ${err?.message || err}`)
  }

  // Initialize default allowed tools for 本地对话 (MCP scope). All tools by default
  // (no global toolEnabled; offline scope is per-conversation selection only).
  if (!offlineAllowedToolsInitialized && offlineAllowedTools.size === 0) {
    const defs = getAllToolDefs()
    if (defs.length > 0) {
      offlineAllowedTools = new Set(defs.map(def => def.name))
      offlineAllowedToolsInitialized = true
    }
  }

  // Prefill inputs
  $<HTMLInputElement>('in-server').value = settings.serverUrl
  $<HTMLInputElement>('in-account').value = settings.userAccount
  $<HTMLInputElement>('in-password').value = settings.userPassword
  $<HTMLInputElement>('in-remember').checked = settings.rememberLogin
  $<HTMLInputElement>('in-agent-name').value = settings.agentName
  $<HTMLInputElement>('in-agent-group').value = settings.agentGroup
  $<HTMLInputElement>('in-workspace').value = settings.workspaceRoot
  $<HTMLInputElement>('cfg-mouse-fx').checked = settings.mouseFx
  $<HTMLInputElement>('cfg-mouse-scale-x').value = String(settings.mouseCoordinateScaleX || 1)
  $<HTMLInputElement>('cfg-mouse-scale-y').value = String(settings.mouseCoordinateScaleY || 1)
  $('theme-toggle').textContent = settings.theme === 'light' ? '☀' : '🌙'
  $<HTMLInputElement>('cfg-ai-key').value = settings.aiKey || ''
  $<HTMLInputElement>('cfg-ai-base').value = settings.aiBaseUrl || ''
  $<HTMLInputElement>('cfg-ai-model').value = settings.aiModel || ''
  $<HTMLTextAreaElement>('offline-prompt-input').value = settings.offlinePrompt || defaults.offlinePrompt || ''

  // Wire events
  $('btn-login').addEventListener('click', () => void doLogin())
  $('btn-logout').addEventListener('click', () => void doLogout())
  $('btn-ping').addEventListener('click', () => void doPing())
  $('btn-reconnect').addEventListener('click', () => {
    agent?.disconnect()
    agent?.connect()
  })
  $('btn-save-settings').addEventListener('click', () => void doSaveSettings())
  $('btn-probe').addEventListener('click', () => void probe(true))
  $('btn-test-run').addEventListener('click', () => void runToolTest())
  $('btn-pause').addEventListener('click', () => void togglePause())
  $('btn-clear-log').addEventListener('click', () => { $('log').innerHTML = '' })

  renderAuthCards()
  renderTools()
  updateStats()
  renderOfflineChat()
  renderOfflineMeta()
  renderOfflineTools()
  updateTokenStats()
  if (settings.authToken) {
    void refreshUserProfile().catch(() => {})
  } else if (settings.userAvatar && !settings.userAvatarDataUrl) {
    void cacheAvatarIfPossible().then(renderAvatar)
  }
  void probe(false)

  // Restore pause state across a reloaded WebView (Rust owns the flag).
  try {
    paused = (await executionState()).paused
    if (paused) $('btn-pause').textContent = '恢复执行'
  } catch { /* ignore */ }

  // Ensure the tray menu (status + pause toggle label) is initialized to match
  // the Electron/windows version even before first status event.
  void native.setTrayStatus(agent?.status || 'disconnected', paused).catch(() => {})

  appendLog('info', `HeySure Device Tauri 原型已启动（${host.hostname}）`)

  if (settings.authToken) {
    agent = buildAgent()
    agent.connect()
  } else {
    renderStatus('disconnected')
  }
}

void boot()
