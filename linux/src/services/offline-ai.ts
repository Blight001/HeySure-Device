import { store } from '../store'
import { getAgent } from './device-runtime'
import { getToolDefs } from '../executor'
import { sendActivityLog } from './activity-log'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

type Role = 'user' | 'assistant'
export interface OfflineChatMessage {
  role: Role
  content: string
}

export interface OfflineToolEvent {
  tool: string
  arguments: Record<string, any>
  success: boolean
  result: any
  summary: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimated?: boolean
}

export interface OfflineChatResult {
  text: string
  think?: string
  toolsUsed: string[]
  toolEvents: OfflineToolEvent[]
  usage?: TokenUsage
}

export type OfflineChatProgress =
  | { type: 'think_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; tool: string; arguments: Record<string, any> }
  | { type: 'tool_result'; event: OfflineToolEvent }

interface AIToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

interface AIResponse {
  text?: string
  think?: string
  toolUses?: AIToolUse[]
  usage?: TokenUsage
}

function stringifyContent(content: any): string {
  if (typeof content === 'string') return content
  try { return JSON.stringify(content) } catch { return String(content) }
}

function imageMimeFromPath(imagePath: string): string | null {
  const ext = path.extname(imagePath).toLowerCase().replace('.', '')
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return null
}

function localImagePathFromValue(value: any): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const filePath = raw.startsWith('file://') ? fileURLToPath(raw) : raw
    if (!imageMimeFromPath(filePath)) return null
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
    return filePath
  } catch {
    return null
  }
}

function dataImageUrlFromValue(value: any): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw) ? raw.replace(/\s+/g, '') : null
}

function collectLocalImagePaths(value: any, seen = new Set<any>()): string[] {
  if (value == null || seen.has(value)) return []
  if (typeof value === 'object') seen.add(value)

  if (typeof value === 'string') {
    const p = localImagePathFromValue(value)
    return p ? [p] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectLocalImagePaths(item, seen))
  }
  if (typeof value !== 'object') return []

  const direct = [
    localImagePathFromValue(value.path),
    localImagePathFromValue(value.image_url),
    localImagePathFromValue(value.screenshot_path),
  ].filter((p): p is string => !!p)
  return [
    ...direct,
    ...collectLocalImagePaths(value.result, seen),
    ...collectLocalImagePaths(value.content, seen),
  ]
}

function collectDataImageUrls(value: any, seen = new Set<any>()): string[] {
  if (value == null || seen.has(value)) return []
  if (typeof value === 'object') seen.add(value)

  if (typeof value === 'string') {
    const url = dataImageUrlFromValue(value)
    return url ? [url] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectDataImageUrls(item, seen))
  }
  if (typeof value !== 'object') return []

  const direct = [
    dataImageUrlFromValue(value.dataUrl),
    dataImageUrlFromValue(value.image_url),
    dataImageUrlFromValue(value.url),
  ].filter((url): url is string => !!url)
  return [
    ...direct,
    ...collectDataImageUrls(value.result, seen),
    ...collectDataImageUrls(value.content, seen),
  ]
}

function imageBlockFromDataUrl(url: string): any | null {
  const match = url.match(/^(data:image\/(?:png|jpe?g|webp|gif);base64,.+)$/i)
  if (!match) return null
  return { type: 'image_url', image_url: { url: match[1] } }
}

function imageContentBlocksFromToolResults(toolResults: any[]): any[] {
  const seen = new Set<string>()
  const images: any[] = []
  for (const tr of toolResults) {
    if (tr?.is_error) continue
    for (const dataUrl of collectDataImageUrls(tr?.content)) {
      if (seen.has(dataUrl)) continue
      seen.add(dataUrl)
      const block = imageBlockFromDataUrl(dataUrl)
      if (block) images.push(block)
    }
    for (const imagePath of collectLocalImagePaths(tr?.content)) {
      const resolved = path.resolve(imagePath)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      const mediaType = imageMimeFromPath(resolved)
      if (!mediaType) continue
      try {
        const data = fs.readFileSync(resolved).toString('base64')
        images.push({
          type: 'image_url',
          image_url: { url: `data:${mediaType};base64,${data}` },
        })
      } catch {
        // If a screenshot was removed between capture and model call, keep the tool result text only.
      }
    }
  }
  return images
}

function redactInlineImages(value: any, seen = new Set<any>()): any {
  if (value == null) return value
  if (typeof value === 'string') {
    return dataImageUrlFromValue(value) ? '[inline image attached as vision input]' : value
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactInlineImages(item, seen))
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(value)) out[k] = redactInlineImages(v, seen)
  return out
}

function screenshotCoordinateHint(toolResults: any[]): string {
  const screenshots: string[] = []
  for (const tr of toolResults) {
    if (tr?.is_error) continue
    const content = tr?.content
    const width = Number(content?.width)
    const height = Number(content?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
    if (!collectLocalImagePaths(content).length && !collectDataImageUrls(content).length) continue
    screenshots.push(`${Math.round(width)}x${Math.round(height)}`)
  }
  const sizeText = screenshots.length ? `当前截图尺寸：${Array.from(new Set(screenshots)).join('、')}。` : ''
  return [
    '视觉工具已返回截图，并在后续消息中附上对应的 base64 data URL。',
    sizeText,
    '截图内容可能已按比例缩放到 1920x1080 以内；后续调用 mouse.* 工具时，直接使用这张返回截图里的坐标，工具会自动换算到真实屏幕坐标。',
    '后续调用 mouse.* 工具时，x/y 必须使用返回截图内容左上角为原点的像素坐标，不要使用 0-1000 归一化坐标。',
    '点击桌面图标、按钮、菜单项时要选目标可点击区域的视觉中心；桌面图标优先点图标图案中心，不要点文字标签上缘或控件边缘。',
  ].filter(Boolean).join(' ')
}

function toolResultContentWithImages(toolResults: any[]): any[] {
  const imageBlocks = imageContentBlocksFromToolResults(toolResults)
  if (!imageBlocks.length) return toolResults
  const safeToolResults = toolResults.map(tr => tr?.type === 'tool_result'
    ? { ...tr, content: redactInlineImages(tr.content) }
    : redactInlineImages(tr))
  return [
    ...safeToolResults,
    {
      type: 'text',
      text: screenshotCoordinateHint(toolResults),
    },
    ...imageBlocks,
  ]
}

function providerToolName(name: string, nameMap: Map<string, string>): string {
  const safe = toolNameForProvider(name)
  nameMap.set(safe, name)
  return safe
}

function providerMessages(messages: any[], nameMap: Map<string, string>): any[] {
  return messages.map(msg => {
    if (Array.isArray(msg.content)) {
      const content = msg.content.map((b: any) => {
        if (msg.role === 'assistant' && b?.type === 'tool_use') {
          return { ...b, name: providerToolName(b.name, nameMap) }
        }
        if (b?.type === 'image_url') {
          const url = String(b.image_url?.url || '')
          const match = url.match(/^data:([^;,]+);base64,(.+)$/)
          if (match) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1],
                data: match[2],
              },
            }
          }
        }
        return b
      })
      return {
        ...msg,
        content,
      }
    }
    return msg
  })
}

function openAiMessages(messages: any[], nameMap: Map<string, string>): any[] {
  const out: any[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolCalls = msg.content
        .filter((b: any) => b?.type === 'tool_use')
        .map((tu: any) => ({
          id: tu.id,
          type: 'function',
          function: { name: providerToolName(tu.name, nameMap), arguments: JSON.stringify(tu.input || {}) },
        }))
      if (toolCalls.length) {
        out.push({ role: 'assistant', content: null, tool_calls: toolCalls })
        continue
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const userBlocks: any[] = []
      for (const tr of msg.content) {
        if (tr?.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id || 'call_0', content: stringifyContent(tr.content) })
          continue
        }
        if (tr?.type === 'image_url') {
          userBlocks.push(tr)
          continue
        }
        if (tr?.type === 'text') {
          userBlocks.push(tr)
        }
      }
      if (userBlocks.length) out.push({ role: 'user', content: userBlocks })
      continue
    }
    out.push({ role: msg.role, content: stringifyContent(msg.content) })
  }
  return out
}

function toolNameForProvider(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '__')
}

function toolNameFromProvider(name: string, nameMap: Map<string, string>): string {
  return nameMap.get(name) || name
}

function toNumber(value: any): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function normalizeUsage(raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  const anthropicInput = [
    toNumber(raw.input_tokens),
    toNumber(raw.cache_creation_input_tokens),
    toNumber(raw.cache_read_input_tokens),
  ].filter((n): n is number => typeof n === 'number')
  const promptTokens = toNumber(raw.prompt_tokens)
  const completionTokens = toNumber(raw.completion_tokens)
  const inputTokens = anthropicInput.length
    ? anthropicInput.reduce((sum, n) => sum + n, 0)
    : promptTokens
  const outputTokens = toNumber(raw.output_tokens) ?? completionTokens
  let totalTokens = toNumber(raw.total_tokens)

  if (totalTokens === undefined && inputTokens !== undefined && outputTokens !== undefined) {
    totalTokens = inputTokens + outputTokens
  }
  if (inputTokens === undefined && totalTokens !== undefined && outputTokens !== undefined) {
    return {
      inputTokens: Math.max(0, totalTokens - outputTokens),
      outputTokens,
      totalTokens,
    }
  }
  if (outputTokens === undefined && totalTokens !== undefined && inputTokens !== undefined) {
    return {
      inputTokens,
      outputTokens: Math.max(0, totalTokens - inputTokens),
      totalTokens,
    }
  }
  if (inputTokens === undefined || outputTokens === undefined) return undefined

  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? inputTokens + outputTokens,
  }
}

function estimateTokensFromText(text: string): number {
  const raw = String(text || '')
  if (!raw.trim()) return 0
  let estimate = 0
  for (const ch of raw) {
    if (/\s/.test(ch)) continue
    if (/[\u4e00-\u9fff]/.test(ch)) estimate += 1
    else if (/[A-Za-z0-9_]/.test(ch)) estimate += 0.25
    else estimate += 0.5
  }
  return Math.max(1, Math.ceil(estimate))
}

function estimateUsageFromCall(systemPrompt: string, messages: any[], tools: any[], resp: AIResponse): TokenUsage {
  const inputText = [systemPrompt, JSON.stringify(messages), JSON.stringify(tools)].join('\n')
  const outputText = [resp.text || '', resp.think || '', JSON.stringify(resp.toolUses || [])].join('\n')
  const inputTokens = estimateTokensFromText(inputText)
  const outputTokens = estimateTokensFromText(outputText)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  }
}

function shouldRetryWithoutStreamUsage(status: number, data: any): boolean {
  if (status !== 400 && status !== 422) return false
  const message = String(data?.error?.message || data?.message || '')
  return /stream_options|include_usage|unknown field|additional property|invalid.*stream/i.test(message)
}

async function readApiError(res: Response): Promise<any> {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function compactDetail(value: any): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function apiErrorMessage(status: number, endpoint: string, data: any): string {
  const detail = data?.error?.message || data?.message || data?.detail || data?.raw || data
  const parts = [
    `AI API error ${status}`,
    `URL: ${endpoint}`,
  ]
  const detailText = compactDetail(detail)
  if (detailText) parts.push(`原因: ${detailText}`)
  return parts.join('\n')
}

function buildEndpoint(baseUrl: string, isAnthropic: boolean): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (isAnthropic) {
    return /\/v1\/messages$/i.test(base) ? base : `${base}/v1/messages`
  }
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/(?:v1|api\/v\d+)$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function createAbortError(): Error {
  const err = new Error('已停止')
  err.name = 'AbortError'
  return err
}

export function isOfflineChatAbortError(err: any, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const name = String(err?.name || '')
  const message = String(err?.message || err || '')
  return name === 'AbortError' || /aborted|canceled|cancelled|已停止/i.test(message)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

function splitThink(text: string): { text: string; think?: string } {
  const raw = String(text || '')
  const match = raw.match(/<think>\s*([\s\S]*?)\s*<\/think>/i)
  if (!match) return { text: raw.trim() }
  return {
    think: String(match[1] || '').trim(),
    text: raw.replace(/<think>\s*[\s\S]*?\s*<\/think>/gi, '').trim(),
  }
}

async function streamOpenAiResponse(
  res: Response,
  nameMap: Map<string, string>,
  onProgress?: (event: OfflineChatProgress) => void,
  signal?: AbortSignal,
): Promise<AIResponse> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('AI API did not return a readable stream')

  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let think = ''
  let usage: TokenUsage | undefined
  const calls = new Map<number, { id: string; name: string; arguments: string }>()

  const handlePayload = (payload: string) => {
    const raw = payload.trim()
    if (!raw || raw === '[DONE]') return
    let data: any
    try { data = JSON.parse(raw) } catch { return }
    if (data.usage) usage = normalizeUsage(data.usage) || usage
    const delta = data.choices?.[0]?.delta || {}
    const reasoning = delta.reasoning_content || delta.reasoning || delta.reasoning_text
    if (reasoning) {
      think += String(reasoning)
      onProgress?.({ type: 'think_delta', text: String(reasoning) })
    }
    if (delta.content) {
      text += String(delta.content)
      onProgress?.({ type: 'text_delta', text: String(delta.content) })
    }
    for (const tc of delta.tool_calls || []) {
      const idx = Number.isFinite(tc.index) ? tc.index : calls.size
      const current = calls.get(idx) || { id: '', name: '', arguments: '' }
      if (tc.id) current.id = tc.id
      if (tc.function?.name) current.name += String(tc.function.name)
      if (tc.function?.arguments) current.arguments += String(tc.function.arguments)
      calls.set(idx, current)
    }
  }

  while (true) {
    throwIfAborted(signal)
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) handlePayload(trimmed.slice(5))
      }
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) handlePayload(trimmed.slice(5))
    }
  }

  const toolUses = Array.from(calls.values())
    .filter(tc => tc.name)
    .map((tc, idx) => ({
      type: 'tool_use' as const,
      id: tc.id || `call_${idx}`,
      name: toolNameFromProvider(tc.name, nameMap),
      input: (() => { try { return JSON.parse(tc.arguments || '{}') } catch { return {} } })(),
    }))
  return { text, think: think.trim() || undefined, toolUses: toolUses.length ? toolUses : undefined, usage }
}

async function callAI(
  messages: any[],
  systemPrompt: string,
  allowedTools?: string[],
  onProgress?: (event: OfflineChatProgress) => void,
  signal?: AbortSignal,
): Promise<AIResponse> {
  const s = store.store
  const baseUrl = String(s.aiBaseUrl || '').replace(/\/+$/, '')
  const apiKey = String(s.aiKey || '').trim()
  const model = String(s.aiModel || '').trim()
  if (!apiKey) throw new Error('未配置 AI Key')
  if (!baseUrl) throw new Error('未配置 Base URL')
  if (!model) throw new Error('未配置模型')

  const isAnthropic = baseUrl.includes('anthropic.com')
  const endpoint = buildEndpoint(baseUrl, isAnthropic)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const allowed = Array.isArray(allowedTools)
    ? new Set(allowedTools.map(t => String(t || '').trim()).filter(Boolean))
    : null
  const nameMap = new Map<string, string>()
  const tools = getToolDefs()
    .filter(t => !allowed || allowed.has(t.name))
    .map(t => ({
      ...t,
      name: providerToolName(t.name, nameMap),
      description: `${t.description}\n\n原始 MCP 工具名: ${t.name}`,
    }))
  const body: any = isAnthropic
    ? {
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: providerMessages(messages, nameMap),
        ...(tools.length ? { tools } : {}),
      }
    : {
        model,
        max_tokens: 4096,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: systemPrompt }, ...openAiMessages(messages, nameMap)],
        ...(tools.length ? { tools: tools.map(t => {
          return {
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }
        }) } : {}),
      }

  const fetchOnce = async (payload: any): Promise<Response> => {
    throwIfAborted(signal)
    return fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal })
  }

  try {
    let res = await fetchOnce(body)
    if (!res.ok) {
      const data: any = await readApiError(res)
      if (!isAnthropic && shouldRetryWithoutStreamUsage(res.status, data)) {
        const fallbackBody = { ...body }
        delete fallbackBody.stream_options
        res = await fetchOnce(fallbackBody)
        if (!res.ok) {
          const retryData: any = await readApiError(res)
          throw new Error(apiErrorMessage(res.status, endpoint, retryData))
        }
      } else {
        throw new Error(apiErrorMessage(res.status, endpoint, data))
      }
    }

    let resp: AIResponse
    if (!isAnthropic) {
      resp = await streamOpenAiResponse(res, nameMap, onProgress, signal)
      if (!resp.usage) resp.usage = estimateUsageFromCall(systemPrompt, messages, tools, resp)
      return resp
    }

    const data: any = await res.json().catch(() => ({}))
    const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n').trim()
    const toolUses = (data.content || [])
      .filter((b: any) => b.type === 'tool_use')
      .map((tu: any) => ({ ...tu, name: toolNameFromProvider(tu.name, nameMap) }))
    resp = { text, toolUses: toolUses.length ? toolUses : undefined, usage: normalizeUsage(data.usage) || estimateUsageFromCall(systemPrompt, messages, tools, { text, toolUses: toolUses.length ? toolUses : undefined }) }
    return resp
  } catch (err: any) {
    if (isOfflineChatAbortError(err, signal)) throw createAbortError()
    throw err
  }
}

export async function runOfflineChat(
  userMessages: OfflineChatMessage[],
  prompt?: string,
  allowedTools?: string[],
  onProgress?: (event: OfflineChatProgress) => void,
  signal?: AbortSignal,
): Promise<OfflineChatResult> {
  const basePrompt = String(prompt || store.get('offlinePrompt') || '').trim()
  const systemPrompt = `${basePrompt}\n\n坐标规则：当你根据 vision.capture / vision.capture_mouse 的截图调用 mouse.* 工具时，x/y 使用返回截图内容左上角为原点的像素坐标；不要使用 0-1000 归一化坐标。截图内容超过 1920x1080 时可能已按比例缩放到 1920x1080 以内，mouse.* 会把返回截图坐标自动换算到真实屏幕坐标。点击目标时选择可点击区域中心，桌面图标优先点图标图案中心，不要点文字标签上缘或边缘。\n\n如果任务需要说明处理思路，可用 <think>...</think> 输出简短、可公开的思考摘要；尽量保持为一个连续栏目，不要刻意空行分段；不要在其中输出敏感信息、密钥或冗长推理。`
  const messages: any[] = userMessages.map(m => ({ role: m.role, content: m.content }))
  const toolsUsed: string[] = []
  const toolEvents: OfflineToolEvent[] = []
  const usageTotal: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const maxTurns = 12

  const addUsage = (usage?: TokenUsage) => {
    if (!usage) return
    usageTotal.inputTokens += Number(usage.inputTokens || 0)
    usageTotal.outputTokens += Number(usage.outputTokens || 0)
    usageTotal.totalTokens += Number(usage.totalTokens || 0)
    usageTotal.estimated = usageTotal.estimated || !!usage.estimated
  }

  for (let i = 0; i < maxTurns; i++) {
    throwIfAborted(signal)
    const resp = await callAI(messages, systemPrompt, allowedTools, onProgress, signal)
    addUsage(resp.usage)
    if (!resp.toolUses?.length) {
      const parsed = splitThink(resp.text || '完成')
      return {
        text: parsed.text || '完成',
        think: resp.think || parsed.think,
        toolsUsed,
        toolEvents,
        usage: usageTotal.totalTokens > 0 ? usageTotal : undefined,
      }
    }

    messages.push({ role: 'assistant', content: resp.toolUses })
    const toolResults: any[] = []
    for (const tu of resp.toolUses) {
      throwIfAborted(signal)
      toolsUsed.push(tu.name)
      onProgress?.({ type: 'tool_start', tool: tu.name, arguments: tu.input || {} })
      sendActivityLog('task', 'running', `[本地AI工具] ${tu.name}`, tu.input)
      try {
        const r = await getAgent()?.runToolLocally(tu.name, tu.input || {})
        throwIfAborted(signal)
        const content = r?.success ? r.result : `Error: ${r?.summary || '工具执行失败'}`
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: !r?.success })
        const event = {
          tool: tu.name,
          arguments: tu.input || {},
          success: !!r?.success,
          result: r?.result ?? null,
          summary: r?.summary || '',
        }
        toolEvents.push(event)
        onProgress?.({ type: 'tool_result', event })
        sendActivityLog('task', r?.success ? 'success' : 'error', `本地工具${r?.success ? '完成' : '失败'}: ${tu.name}`)
      } catch (err: any) {
        if (isOfflineChatAbortError(err, signal)) throw createAbortError()
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err?.message || err}`, is_error: true })
        const event = {
          tool: tu.name,
          arguments: tu.input || {},
          success: false,
          result: null,
          summary: err?.message || String(err),
        }
        toolEvents.push(event)
        onProgress?.({ type: 'tool_result', event })
        sendActivityLog('task', 'error', `本地工具异常: ${tu.name} - ${err?.message || err}`)
      }
    }
    messages.push({ role: 'user', content: toolResultContentWithImages(toolResults) })
  }

  return { text: '已达到最大工具调用轮次。', toolsUsed, toolEvents, usage: usageTotal.totalTokens > 0 ? usageTotal : undefined }
}
