import { ChatMessage, AIToolDef, AIToolUse } from './types'

export interface AIResponse {
  text?:      string
  toolUses?:  AIToolUse[]
  stopReason?: string
}

function dataUrlParts(dataUrl: string): { mediaType: string; data: string } | null {
  const m = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/)
  if (!m) return null
  return { mediaType: m[1] || 'image/png', data: m[2] || '' }
}

function anthropicMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
}

function stringifyToolContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(item => item?.type !== 'image')
      .map(item => item?.type === 'text' ? String(item.text || '') : JSON.stringify(item))
      .filter(Boolean)
      .join('\n')
  }
  try { return JSON.stringify(content) } catch { return String(content) }
}

function openAiMessages(messages: ChatMessage[]): any[] {
  const out: any[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === 'tool_use')) {
      const toolCalls = (msg.content as any[])
        .filter((b: any) => b?.type === 'tool_use')
        .map((tu: any) => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input || {}),
          },
        }))
      out.push({ role: 'assistant', content: null, tool_calls: toolCalls })
      continue
    }

    if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === 'tool_result')) {
      const imageMessages: any[] = []
      for (const tr of msg.content as any[]) {
        if (tr?.type !== 'tool_result') continue
        const content = tr.content
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id || 'call_0',
          content: stringifyToolContent(content),
        })

        const blocks = Array.isArray(content) ? content : []
        const image = blocks.find((b: any) => b?.type === 'image')
        if (image?.source?.type === 'base64' && image.source.data) {
          const mediaType = image.source.media_type || 'image/png'
          const dataUrl = `data:${mediaType};base64,${image.source.data}`
          const text = blocks.find((b: any) => b?.type === 'text')?.text || 'Screenshot captured by browser_screenshot.'
          imageMessages.push({
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          })
        }
      }
      out.push(...imageMessages)
      continue
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const parts: any[] = []
      for (const item of msg.content as any[]) {
        if (item?.type === 'text') parts.push({ type: 'text', text: String(item.text || '') })
        else if (item?.type === 'image' && item.source?.type === 'base64') {
          const dataUrl = `data:${item.source.media_type || 'image/png'};base64,${item.source.data || ''}`
          parts.push({ type: 'image_url', image_url: { url: dataUrl } })
        } else if (item?.type === 'image_url') {
          parts.push(item)
        }
      }
      out.push({ role: msg.role, content: parts.length ? parts : stringifyToolContent(msg.content) })
      continue
    }

    out.push({ role: msg.role, content: typeof msg.content === 'string' ? msg.content : stringifyToolContent(msg.content) })
  }
  return out
}

export function screenshotToolContent(result: any): any {
  const parsed = dataUrlParts(result?.dataUrl || '')
  if (!parsed) return typeof result === 'string' ? result : JSON.stringify(result)
  return [
    { type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } },
    { type: 'text', text: `Screenshot of: ${result.url || 'current page'}\nMethod: ${result.method || 'browser_screenshot'}` },
  ]
}

export async function callAI(
  baseUrl:      string,
  apiKey:       string,
  model:        string,
  messages:     ChatMessage[],
  tools?:       AIToolDef[],
  systemPrompt?: string,
): Promise<AIResponse> {
  if (!apiKey) throw new Error('AI Key is not configured')
  const isAnthropic = baseUrl.includes('anthropic.com')
  const endpoint    = isAnthropic
    ? `${baseUrl.replace(/\/$/, '')}/v1/messages`
    : `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key']          = apiKey
    headers['anthropic-version']  = '2023-06-01'
    // Anthropic rejects any request that carries a browser Origin unless this
    // opt-in header is present. The extension service worker sends a
    // chrome-extension:// origin, so without it every direct call (e.g. the
    // 本地对话 window) fails with a CORS-style error.
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  let body: any
  if (isAnthropic) {
    body = { model, max_tokens: 4096, messages: anthropicMessages(messages) }
    if (tools?.length)  body.tools  = tools
    if (systemPrompt)   body.system = systemPrompt
  } else {
    // OpenAI-compatible: inject system as first message
    const oaMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...openAiMessages(messages)]
      : openAiMessages(messages)
    body = { model, max_tokens: 4096, messages: oaMessages }
    if (tools?.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }))
    }
  }

  // A stalled connection (dropped packets, no RST) leaves plain fetch() hanging
  // indefinitely with no way to cancel — this is what makes chat look "stuck" under
  // network fluctuation. AbortController turns that into a bounded, clear failure.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  let res: Response
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('AI API request timed out after 60s')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const data: any = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `AI API error ${res.status}`)

  if (isAnthropic) {
    const textBlock    = data.content?.find((b: any) => b.type === 'text')
    const toolUseBlocks: AIToolUse[] = (data.content || []).filter((b: any) => b.type === 'tool_use')
    return {
      text:       textBlock?.text,
      toolUses:   toolUseBlocks.length ? toolUseBlocks : undefined,
      stopReason: data.stop_reason,
    }
  } else {
    const choice = data.choices?.[0]
    if (choice?.message?.tool_calls?.length) {
      const toolUses: AIToolUse[] = choice.message.tool_calls.map((tc: any) => ({
        type:  'tool_use',
        id:    tc.id,
        name:  tc.function.name,
        input: (() => { try { return JSON.parse(tc.function.arguments || '{}') } catch { return {} } })(),
      }))
      return { toolUses, stopReason: choice.finish_reason }
    }
    return { text: choice?.message?.content || '', stopReason: choice?.finish_reason }
  }
}
