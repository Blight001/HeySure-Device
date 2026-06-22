// renderer.ts — HeySure Agent desktop renderer process.
//
// The desktop app is a thin tool-calling endpoint. Its main area is the desktop
// MCP tool page. The account, the 3-state connection indicator and settings are
// surfaced through header controls and modals. AI assignment is controlled
// server-side from the web Workshop ("作坊") panel — the device no longer picks
// an AI.

interface ToolDef {
  name: string
  description: string
  input_schema: { type: string; properties: Record<string, any>; required?: string[] }
}

interface Window {
  heysureAPI: {
    getSettings: () => Promise<any>
    saveSettings: (s: any) => Promise<any>
    autoCalibrateMouse: () => Promise<any>
    connect: () => Promise<boolean>
    disconnect: () => Promise<boolean>
    getStatus: () => Promise<string>
    onStatusChange: (cb: (status: string, reason?: string, aiConfigId?: number | null) => void) => void
    onActivityLog: (cb: (entry: any) => void) => void
    onTaskStart: (cb: (data: any) => void) => void
    onTaskResult: (cb: (data: any) => void) => void
    onAuthExpired: (cb: (reason: string) => void) => void
    onAuthRefreshed: (cb: () => void) => void
    onReconnecting: (cb: (active: boolean, reason: string | null) => void) => void
    setTheme: (theme: 'dark' | 'light') => Promise<void>
    minimizeWindow: () => Promise<boolean>
    toggleMaximizeWindow: () => Promise<boolean>
    closeWindow: () => Promise<boolean>
    isWindowMaximized: () => Promise<boolean>
    testConnection: () => Promise<{ success: boolean; status?: number; ms?: number; error?: string }>
    login: (params: { serverUrl: string; account: string; password: string; remember?: boolean }) => Promise<{ success: boolean; user: any }>
    logout: () => Promise<{ success: boolean }>
    mcpList: () => Promise<{ tools: ToolDef[]; overrides: Record<string, { description?: string; parameters?: Record<string, string> }>; enabled?: Record<string, boolean> }>
    mcpSaveDesc: (p: { tool: string; description?: string; parameters?: Record<string, string> }) => Promise<boolean>
    mcpSetEnabled: (p: { tool: string; enabled: boolean }) => Promise<boolean>
    mcpTest: (p: { tool: string; args: Record<string, any> }) => Promise<{ success: boolean; result?: any; summary?: string; error?: string }>
    openOfflineChat: () => Promise<boolean>
    version: string
  }
}

const $ = (id: string) => document.getElementById(id)!
const windowMinBtn = $('window-min-btn') as HTMLButtonElement
const windowMaxBtn = $('window-max-btn') as HTMLButtonElement
const windowCloseBtn = $('window-close-btn') as HTMLButtonElement
const offlineChatBtn = $('offline-chat-btn') as HTMLButtonElement

// ── State ──────────────────────────────────────────────────────────────────
let currentTheme: 'dark' | 'light' = 'dark'
let currentStatus = 'disconnected'
// True while the agent is auto-reconnecting (socket.io retry or silent
// re-login after a server update) — drives the orange "reconnecting" prompt.
let reconnecting = false
let reconnectingReason = ''
let boundAiConfigId: number | null = null
let totalCalls = 0, successCalls = 0, failedCalls = 0, runningCalls = 0
let toolDefs: ToolDef[] = []
let overrides: Record<string, { description?: string; parameters?: Record<string, string> }> = {}
let toolEnabled: Record<string, boolean> = {}

type ParentGroup = 'sensory' | 'learning' | 'tool' | 'other'
type ToolGroup =
  | 'mouse'
  | 'keyboard'
  | 'text'
  | 'speech'
  | 'vision'
  | 'hands'
  | 'display'
  | 'clipboard'
  | 'card'
  | 'shell'
  | 'window'

interface DisplayMeta {
  zh: string
  en: string
  parent: ParentGroup
}

const PARENT_ORDER: ParentGroup[] = ['sensory', 'learning', 'tool', 'other']

const PARENT_META: Record<ParentGroup, { zh: string; en: string }> = {
  sensory: { zh: '感官类', en: 'SENSORY' },
  learning: { zh: '学习类', en: 'LEARNING' },
  tool: { zh: '工具类', en: 'TOOLS' },
  other: { zh: '其他类', en: 'OTHER' },
}

const GROUP_META: Record<ToolGroup, DisplayMeta> = {
  mouse: { zh: '鼠标', en: 'MOUSE', parent: 'sensory' },
  keyboard: { zh: '键盘', en: 'KEYBOARD', parent: 'sensory' },
  text: { zh: '文本输入', en: 'TEXT INPUT', parent: 'tool' },
  speech: { zh: '语音', en: 'SPEECH', parent: 'sensory' },
  vision: { zh: '视觉', en: 'VISION', parent: 'sensory' },
  hands: { zh: '手势', en: 'HANDS', parent: 'learning' },
  display: { zh: '显示', en: 'DISPLAY', parent: 'tool' },
  clipboard: { zh: '剪贴板', en: 'CLIPBOARD', parent: 'tool' },
  card: { zh: '卡片', en: 'CARD', parent: 'tool' },
  shell: { zh: '命令行', en: 'SHELL', parent: 'tool' },
  window: { zh: '窗口', en: 'WINDOW', parent: 'tool' },
}

const GROUP_ORDER: Record<ParentGroup, ToolGroup[]> = {
  sensory: ['mouse', 'keyboard', 'speech', 'vision'],
  learning: ['hands'],
  tool: ['text', 'display', 'clipboard', 'card', 'shell', 'window'],
  other: [],
}

const KNOWN_GROUPS = new Set<ToolGroup>([
  'mouse',
  'keyboard',
  'text',
  'speech',
  'vision',
  'hands',
  'display',
  'clipboard',
  'card',
  'shell',
  'window',
])

const TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  'mouse.move': { zh: '鼠标移动', en: 'Mouse Move' },
  'mouse.click': { zh: '鼠标点击', en: 'Mouse Click' },
  'mouse.double_click': { zh: '鼠标双击', en: 'Mouse Double Click' },
  'mouse.right_click': { zh: '鼠标右键', en: 'Mouse Right Click' },
  'mouse.scroll': { zh: '鼠标滚动', en: 'Mouse Scroll' },
  'mouse.drag': { zh: '鼠标拖拽', en: 'Mouse Drag' },
  'keyboard.type': { zh: '键盘输入', en: 'Type Text' },
  'keyboard.press': { zh: '键盘按键', en: 'Press Keys' },
  'text.input': { zh: '大段文本输入', en: 'Large Text Input' },
  'speech.speak': { zh: '语音朗读', en: 'Speak' },
  'vision.capture': { zh: '屏幕采集', en: 'Screen Capture' },
  'vision.capture_mouse': { zh: '鼠标区域采集', en: 'Mouse Area Capture' },
  'display.box': { zh: '屏幕高亮', en: 'Highlight Box' },
  'display.clear': { zh: '清除高亮', en: 'Clear Highlights' },
  'clipboard.get': { zh: '读取剪贴板', en: 'Get Clipboard' },
  'clipboard.set': { zh: '写入剪贴板', en: 'Set Clipboard' },
  'shell.run': { zh: '命令执行', en: 'Run Command' },
  'window.list': { zh: '窗口列表', en: 'List Windows' },
  'window.focus': { zh: '窗口聚焦', en: 'Focus Window' },
  'window.close': { zh: '关闭窗口', en: 'Close Window' },
  'hands.start': { zh: '开始输入采集', en: 'Start Capture' },
  'hands.stop': { zh: '停止输入采集', en: 'Stop Capture' },
  'hands.snapshot': { zh: '输入快照', en: 'Input Snapshot' },
  'hands.events': { zh: '输入事件', en: 'Input Events' },
  'hands.mouse': { zh: '鼠标输入', en: 'Mouse Input' },
}

function toTitleCase(value: string): string {
  return String(value)
    .replace(/[._-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function toolGroupKey(name: string): ToolGroup | 'other' {
  const raw = String(name || '')
  const ns = raw.includes('.') ? raw.split('.')[0] : raw.includes('_') ? raw.slice(0, raw.indexOf('_')) : raw
  const key = ns.toLowerCase()
  return KNOWN_GROUPS.has(key as ToolGroup) ? (key as ToolGroup) : 'other'
}

function groupMeta(name: string): DisplayMeta {
  const key = toolGroupKey(name)
  return GROUP_META[key as ToolGroup] || { zh: toTitleCase(key), en: toTitleCase(key).toUpperCase(), parent: 'other' }
}

function toolMeta(name: string): { zh: string; en: string; group: ToolGroup | 'other'; parent: ParentGroup } {
  const group = toolGroupKey(name)
  const gMeta = GROUP_META[group as ToolGroup]
  const meta = TOOL_LABELS[name]
  return {
    zh: meta?.zh || toTitleCase(name),
    en: meta?.en || toTitleCase(name),
    group,
    parent: gMeta?.parent || 'other',
  }
}

function renderToolItem(tool: ToolDef): string {
  const meta = toolMeta(tool.name)
  const enabled = isToolEnabled(tool.name)
  return `
    <div class="tool-item ${enabled ? '' : 'disabled'}" data-tool="${esc(tool.name)}">
      <div class="tool-item-top">
        <input class="tool-enabled" type="checkbox" data-toggle-tool="${esc(tool.name)}" ${enabled ? 'checked' : ''} title="是否向软件端和离线模型开放该 MCP 工具"/>
        <div class="tool-title">
          <span class="tool-name">${esc(meta.zh)}</span>
          <span class="tool-name-sub">${esc(meta.en)}</span>
        </div>
        ${enabled ? '' : '<span class="tool-off">已关闭</span>'}
        ${isEdited(tool.name) ? '<span class="tool-edited">已自定义</span>' : ''}
      </div>
      <div class="tool-desc">${esc((effDesc(tool) || '（无描述）').slice(0, 120))}</div>
    </div>`
}

function renderGroup(parent: ParentGroup, group: ToolGroup, tools: ToolDef[]): string {
  if (!tools.length) return ''
  const meta = GROUP_META[group] || groupMeta(group)
  const enabledCount = tools.filter(t => isToolEnabled(t.name)).length
  const allChecked = enabledCount === tools.length
  return `
    <section class="mcp-group" data-group="${esc(group)}">
      <div class="mcp-group-title">
        <input class="mcp-group-toggle" type="checkbox" data-toggle-tools="${esc(toolDataValue(tools))}" ${allChecked ? 'checked' : ''} title="切换该分组 MCP 工具"/>
        <span class="mcp-group-zh">${esc(meta.zh)}</span>
        <span class="mcp-group-en">${esc(meta.en)}</span>
        <span class="mcp-group-count">${enabledCount}/${tools.length} 开放</span>
      </div>
      <div class="mcp-group-items">
        ${tools.map(renderToolItem).join('')}
      </div>
    </section>`
}

function renderParentSection(parent: ParentGroup, childMap: Map<string, ToolDef[]>, open = false): string {
  const orderedGroups = parent === 'other'
    ? Array.from(childMap.keys()).sort() as ToolGroup[]
    : GROUP_ORDER[parent].filter(group => childMap.has(group))
  if (!orderedGroups.length) return ''
  const count = orderedGroups.reduce((sum, group) => sum + (childMap.get(group)?.length || 0), 0)
  const tools = orderedGroups.flatMap(group => childMap.get(group) || [])
  const enabledCount = tools.filter(t => isToolEnabled(t.name)).length
  const allChecked = tools.length > 0 && enabledCount === tools.length
  const body = orderedGroups.map(group => renderGroup(parent, group, childMap.get(group) || [])).join('')
  return `
    <details class="mcp-parent" data-parent="${parent}"${open ? ' open' : ''}>
      <summary>
        <span class="mcp-parent-summary-left">
          <span class="mcp-chevron"></span>
          <input class="mcp-parent-toggle" type="checkbox" data-toggle-tools="${esc(toolDataValue(tools))}" ${allChecked ? 'checked' : ''} title="切换该栏目 MCP 工具"/>
          <span class="mcp-parent-labels">
            <span class="mcp-parent-zh">${esc(PARENT_META[parent].zh)}</span>
            <span class="mcp-parent-en">${esc(PARENT_META[parent].en)}</span>
          </span>
        </span>
        <span class="mcp-parent-count">${enabledCount}/${count} 开放</span>
      </summary>
      <div class="mcp-parent-body">${body}</div>
    </details>`
}

function esc(str: string) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function toolDataValue(tools: ToolDef[]): string {
  return tools.map(t => t.name).join('|')
}

function toolsFromData(value: string): string[] {
  return String(value || '').split('|').map(t => t.trim()).filter(Boolean)
}

function isToolEnabled(name: string): boolean {
  return toolEnabled[name] !== false
}

async function setToolEnabled(name: string, enabled: boolean): Promise<void> {
  if (!name) return
  if (enabled) delete toolEnabled[name]
  else toolEnabled[name] = false
  renderMcpList()
  await window.heysureAPI.mcpSetEnabled({ tool: name, enabled })
  await loadMcp()
}

async function setToolsEnabled(names: string[], enabled: boolean): Promise<void> {
  const unique = Array.from(new Set(names.filter(Boolean)))
  if (!unique.length) return
  for (const name of unique) {
    if (enabled) delete toolEnabled[name]
    else toolEnabled[name] = false
  }
  renderMcpList()
  for (const name of unique) await window.heysureAPI.mcpSetEnabled({ tool: name, enabled })
  await loadMcp()
}

// ── Theme (also recolors the Electron window via setTheme IPC) ───────────────
function applyTheme(theme: 'dark' | 'light', persist = true) {
  currentTheme = theme
  document.documentElement.className = theme
  document.body.className = theme
  $('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙'
  if (persist) window.heysureAPI.setTheme(theme)
}
$('theme-toggle').addEventListener('click', () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'))

function syncWindowMaxButton(isMaximized: boolean) {
  windowMaxBtn.classList.toggle('restore', isMaximized)
  windowMaxBtn.classList.toggle('max', !isMaximized)
  windowMaxBtn.title = isMaximized ? '还原' : '最大化'
  windowMaxBtn.setAttribute('aria-label', isMaximized ? '还原' : '最大化')
}
windowMinBtn.addEventListener('click', () => window.heysureAPI.minimizeWindow())
windowMaxBtn.addEventListener('click', async () => {
  syncWindowMaxButton(await window.heysureAPI.toggleMaximizeWindow())
})
windowCloseBtn.addEventListener('click', () => window.heysureAPI.closeWindow())

// ── Status indicator (green / yellow / red) ─────────────────
const STATUS_LABELS: Record<string, string> = {
  disconnected: '未连接', connecting: '连接中...', connected: '已连接', registered: '已连接到服务器', error: '连接错误',
}
function renderStatus() {
  const statusPill = $('status-pill')
  const showReconnecting = reconnecting
  statusPill.classList.toggle('reconnecting', showReconnecting)
  if (showReconnecting) {
    $('status-dot').className = 'status-dot orange'
    $('status-label').textContent = '重连中…'
    statusPill.title = reconnectingReason || '正在自动重连服务器'
    $('info-status').textContent = reconnectingReason || '正在自动重连…'
    $('info-ai').textContent = boundAiConfigId == null ? '未分配' : `#${boundAiConfigId}`
    return
  }
  const connected = currentStatus === 'registered' || currentStatus === 'connected'
  let color: 'green' | 'yellow' | 'red', label: string
  if (!connected) { color = 'red'; label = '未连接' }
  else if (boundAiConfigId == null) { color = 'yellow'; label = '未分配 AI' }
  else { color = 'green'; label = '已连接' }
  $('status-dot').className = `status-dot ${color}`
  $('status-label').textContent = label
  statusPill.title = '连接状态'
  $('info-status').textContent = STATUS_LABELS[currentStatus] || currentStatus
  $('info-ai').textContent = boundAiConfigId == null ? '未分配' : `#${boundAiConfigId}`
  updateConnectionButtons()
}
function setStatus(status: string, _reason?: string, aiConfigId?: number | null) {
  currentStatus = status
  // Back online — the reconnect is over (also signalled by onReconnecting, but
  // clear here too so the orange prompt never lingers).
  if (status === 'registered' || status === 'connected') reconnecting = false
  if (status !== 'registered' && status !== 'connected') boundAiConfigId = null
  else if (typeof aiConfigId !== 'undefined') boundAiConfigId = aiConfigId
  renderStatus()
  if (status === 'disconnected' || status === 'error' || status === 'registered') {
    void loadMcp()
  }
}
function setReconnecting(active: boolean, reason?: string | null) {
  reconnecting = active
  reconnectingReason = active ? (reason || '正在自动重连服务器') : ''
  renderStatus()
}

function updateConnectionButtons() {
  const connected = currentStatus === 'connected' || currentStatus === 'registered'
  const busy = currentStatus === 'connecting' || reconnecting
  const connectBtn = $('connect-btn') as HTMLButtonElement
  const disconnectBtn = $('disconnect-btn') as HTMLButtonElement
  connectBtn.disabled = busy || connected
  disconnectBtn.disabled = busy || !connected
  connectBtn.textContent = busy ? '连接中...' : connected ? '已连接' : '连接'
}

// ── Tool-call stats ──────────────────────────────────────────────────────
function updateStats() {
  $('stat-total').textContent = String(totalCalls)
  $('stat-success').textContent = String(successCalls)
  $('stat-failed').textContent = String(failedCalls)
  $('stat-running').textContent = String(runningCalls)
}

// ── MCP tool page ──────────────────────────────────────────────────────────
function isEdited(name: string): boolean {
  const o = overrides[name]
  return !!(o && (o.description || (o.parameters && Object.keys(o.parameters).length)))
}
function effDesc(t: ToolDef): string { return overrides[t.name]?.description?.trim() || t.description || '' }
function effParam(tool: string, p: string, raw: string): string { return overrides[tool]?.parameters?.[p]?.trim() || raw || '' }

function showList() {
  $('mcp-detail-pane').classList.add('hidden')
  $('mcp-list-pane').classList.remove('hidden')
}

async function loadMcp() {
  const list = $('mcp-list')
  const openParents = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>('details.mcp-parent[open]')).map(el => el.dataset.parent || ''))
  const scrollTop = list.scrollTop
  const data = await window.heysureAPI.mcpList()
  toolDefs = data.tools || []
  overrides = data.overrides || {}
  toolEnabled = data.enabled || {}
  renderMcpList(openParents, scrollTop)
}

function renderMcpList(openParents = new Set<string>(), scrollTop = 0) {
  const list = $('mcp-list')
  const parentMaps = new Map<ParentGroup, Map<ToolGroup | 'other', ToolDef[]>>()
  for (const parent of PARENT_ORDER) parentMaps.set(parent, new Map())

  for (const tool of toolDefs) {
    const meta = toolMeta(tool.name)
    const parent = meta.parent
    if (!parentMaps.has(parent)) parentMaps.set(parent, new Map())
    const groupMap = parentMaps.get(parent)!
    const groupKey = meta.group
    if (!groupMap.has(groupKey)) groupMap.set(groupKey, [])
    groupMap.get(groupKey)!.push(tool)
  }

  const renderedParents: ParentGroup[] = []
  const html: string[] = []
  for (const parent of PARENT_ORDER) {
    const childMap = parentMaps.get(parent)
    if (!childMap || !childMap.size) continue
    const open = openParents.has(parent)
    const parentHtml = renderParentSection(parent, childMap, open)
    if (parentHtml) {
      renderedParents.push(parent)
      html.push(parentHtml)
    }
  }

  list.innerHTML = html.length ? html.join('') : '<div class="empty-note">无可用工具</div>'
  $('mcp-count').textContent = html.length ? `${toolDefs.length} 个 · ${renderedParents.length} 类` : '0 个'
  list.querySelectorAll<HTMLDivElement>('.tool-item').forEach(el => {
    el.addEventListener('click', () => openTool(el.dataset.tool || ''))
  })
  list.querySelectorAll<HTMLInputElement>('[data-toggle-tool]').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation())
    el.addEventListener('change', () => void setToolEnabled(el.dataset.toggleTool || '', el.checked))
  })
  list.querySelectorAll<HTMLInputElement>('[data-toggle-tools]').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation())
    el.addEventListener('change', () => void setToolsEnabled(toolsFromData(el.dataset.toggleTools || ''), el.checked))
  })
  list.scrollTop = scrollTop
}

function paramEntries(t: ToolDef) {
  const props = t.input_schema?.properties || {}
  const required = new Set(t.input_schema?.required || [])
  return Object.keys(props).map(p => {
    const cfg = (props as any)[p] || {}
    const ty = Array.isArray(cfg.type) ? cfg.type.join('|') : (cfg.type || 'any')
    return { name: p, type: String(ty), required: required.has(p), desc: String(cfg.description || '') }
  })
}

function openTool(name: string) {
  const tool = toolDefs.find(t => t.name === name)
  if (!tool) return
  $('mcp-list-pane').classList.add('hidden')
  $('mcp-detail-pane').classList.remove('hidden')
  $('mcp-detail').scrollTop = 0
  renderDetail(tool)
}

function renderDetail(tool: ToolDef) {
  const meta = toolMeta(tool.name)
  const params = paramEntries(tool)
  const enabled = isToolEnabled(tool.name)
  const paramHtml = params.length
    ? params.map(p => `
        <div class="param-row">
          <div class="param-head">
            <span class="param-name">${esc(p.name)}</span>
            <span class="param-type">${esc(p.type)}</span>
            ${p.required ? '<span class="param-req">必填</span>' : ''}
          </div>
          <div class="tool-desc">${esc(effParam(tool.name, p.name, p.desc) || '（无说明）')}</div>
          <input type="text" data-param="${esc(p.name)}" class="edit-param" placeholder="自定义参数说明（留空用默认）" value="${esc(overrides[tool.name]?.parameters?.[p.name] || '')}" style="margin-top:5px;"/>
        </div>`).join('')
    : '<div class="empty-note">该工具无参数</div>'
  const argTemplate = JSON.stringify(Object.fromEntries(params.filter(p => p.required).map(p => [p.name, ''])), null, 2)

  $('mcp-detail').innerHTML = `
    <div class="card">
      <div class="tool-title-row">
        <div class="tool-title-stack">
          <div class="tool-title-main">${esc(meta.zh)}</div>
          <div class="tool-title-sub">${esc(meta.en)}</div>
        </div>
        <div class="tool-title-id">${esc(tool.name)}</div>
      </div>
      <div class="tool-desc" style="font-size:12px;">${esc(effDesc(tool) || '（无描述）')}</div>
      <label class="check-row tool-enable-row">
        <input type="checkbox" id="detail-enabled" ${enabled ? 'checked' : ''}/>
        <span>${enabled ? '已向软件端开放该 MCP 工具' : '该 MCP 工具已关闭，不会上报给服务器或离线模型'}</span>
      </label>
    </div>
    <div class="card">
      <div class="card-title">参数说明</div>
      ${paramHtml}
    </div>
    <div class="card">
      <div class="card-title">编辑描述（本地保存，随上报同步给服务器）</div>
      <div class="fg"><label>工具描述（用途 + 使用场景）</label>
        <textarea class="ta" id="edit-desc" placeholder="留空使用默认描述">${esc(overrides[tool.name]?.description || '')}</textarea>
      </div>
      <button class="btn btn-primary" id="edit-save">保存描述</button>
      <button class="btn btn-secondary" id="edit-reset">恢复默认</button>
      <div class="save-feedback" id="edit-feedback"></div>
    </div>
    <div class="card">
      <div class="card-title">测试调用 (mcp.test)</div>
      <div class="login-hint">在本机直接执行该工具并返回原始结果。</div>
      <div class="fg"><label>参数 (JSON)</label>
        <textarea class="ta" id="test-args" style="min-height:72px;font-family:'Cascadia Code',Consolas,monospace;">${esc(argTemplate)}</textarea>
      </div>
      <button class="btn btn-primary" id="test-run" ${enabled ? '' : 'disabled'}>测试</button>
      <div class="test-result" id="test-result" style="display:none;"></div>
    </div>`

  $('detail-enabled').addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked
    await setToolEnabled(tool.name, checked)
    const t = toolDefs.find(x => x.name === tool.name)
    if (t) renderDetail(t)
  })

  $('edit-save').addEventListener('click', async () => {
    const description = ($('edit-desc') as HTMLTextAreaElement).value
    const parameters: Record<string, string> = {}
    $('mcp-detail').querySelectorAll<HTMLInputElement>('.edit-param').forEach(inp => { parameters[inp.dataset.param!] = inp.value })
    await window.heysureAPI.mcpSaveDesc({ tool: tool.name, description, parameters })
    await loadMcp()
    const fb = $('edit-feedback'); fb.textContent = '已保存 ✓ 已同步给服务器'; fb.style.color = 'var(--success)'
  })
  $('edit-reset').addEventListener('click', async () => {
    await window.heysureAPI.mcpSaveDesc({ tool: tool.name, description: '', parameters: {} })
    await loadMcp()
    const t = toolDefs.find(x => x.name === tool.name); if (t) renderDetail(t)
  })
  $('test-run').addEventListener('click', async () => {
    const out = $('test-result')
    let args: Record<string, any> = {}
    const raw = ($('test-args') as HTMLTextAreaElement).value.trim()
    if (raw) {
      try { args = JSON.parse(raw) } catch (e: any) {
        out.style.display = 'block'; out.className = 'test-result fail'; out.textContent = `参数 JSON 解析失败：${e?.message || e}`; return
      }
    }
    out.style.display = 'block'; out.className = 'test-result'; out.textContent = '执行中…'
    try {
      const r = await window.heysureAPI.mcpTest({ tool: tool.name, args })
      if (r.success) { out.className = 'test-result ok'; out.textContent = '成功\n' + safeStringify(r.result) }
      else { out.className = 'test-result fail'; out.textContent = '失败：' + (r.error || r.summary || '未知错误') }
    } catch (err: any) {
      out.className = 'test-result fail'; out.textContent = '失败：' + (err?.message || err)
    }
  })
}
function safeStringify(v: any): string { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) } catch { return String(v) } }

$('mcp-back').addEventListener('click', showList)

// ── Settings modal ───────────────────────────────────────────────────────
const cfgServer    = $('cfg-server') as HTMLInputElement
const cfgWorkspace = $('cfg-workspace') as HTMLInputElement
const cfgMouseFx   = $('cfg-mouse-fx') as HTMLInputElement
const cfgMouseScaleX = $('cfg-mouse-scale-x') as HTMLInputElement
const cfgMouseScaleY = $('cfg-mouse-scale-y') as HTMLInputElement
const calibrateMouseBtn = $('calibrate-mouse-btn') as HTMLButtonElement

function numericInputValue(input: HTMLInputElement, fallback: number): number {
  const n = Number(input.value)
  return Number.isFinite(n) ? n : fallback
}

offlineChatBtn.title = '打开本地对话'
offlineChatBtn.addEventListener('click', () => window.heysureAPI.openOfflineChat())

function openSettings()  { $('settings-modal').classList.remove('hidden') }
function closeSettings() { $('settings-modal').classList.add('hidden') }
$('settings-btn').addEventListener('click', openSettings)
$('settings-close').addEventListener('click', closeSettings)
$('settings-modal').addEventListener('click', e => { if (e.target === $('settings-modal')) closeSettings() })

$('save-btn').addEventListener('click', async () => {
  const fb = $('save-feedback')
  try {
    await window.heysureAPI.saveSettings({
      serverUrl: cfgServer.value.trim(),
      workspaceRoot: cfgWorkspace.value.trim(),
      mouseFx: cfgMouseFx.checked,
      mouseCoordinateScaleX: numericInputValue(cfgMouseScaleX, 1),
      mouseCoordinateScaleY: numericInputValue(cfgMouseScaleY, 1),
    })
    setStatus(await window.heysureAPI.getStatus())
    $('info-server').textContent = cfgServer.value.trim() || '—'
    $('info-workspace').textContent = cfgWorkspace.value.trim() ? (cfgWorkspace.value.trim().split(/[/\\]/).pop() || cfgWorkspace.value.trim()) : '—'
    fb.style.color = 'var(--success)'; fb.textContent = '已保存 ✓'
    setTimeout(() => { fb.textContent = '' }, 2000)
  } catch {
    fb.style.color = 'var(--error)'; fb.textContent = '保存失败'
    setTimeout(() => { fb.textContent = '' }, 3000)
  }
})

calibrateMouseBtn.addEventListener('click', async () => {
  const fb = $('calibrate-feedback')
  calibrateMouseBtn.disabled = true
  fb.style.color = 'var(--muted)'
  fb.textContent = '校准中...'
  try {
    const result = await window.heysureAPI.autoCalibrateMouse()
    const sx = Number(result.mouseCoordinateScaleX)
    const sy = Number(result.mouseCoordinateScaleY)
    cfgMouseScaleX.value = String(Number.isFinite(sx) ? sx : 1)
    cfgMouseScaleY.value = String(Number.isFinite(sy) ? sy : 1)
    fb.style.color = 'var(--success)'
    fb.textContent = `已校准：X ${cfgMouseScaleX.value} / Y ${cfgMouseScaleY.value}`
    setTimeout(() => { fb.textContent = '' }, 3500)
  } catch (err: any) {
    fb.style.color = 'var(--error)'
    fb.textContent = err?.message || '自动校准失败'
    setTimeout(() => { fb.textContent = '' }, 5000)
  } finally {
    calibrateMouseBtn.disabled = false
  }
})

// ── Members modal (connection + AI assignment info) ─────────────────────────
function openMembers()  { $('members-modal').classList.remove('hidden'); renderStatus() }
function closeMembers() { $('members-modal').classList.add('hidden') }
$('status-pill').addEventListener('click', openMembers)
$('members-modal-close').addEventListener('click', closeMembers)
$('members-modal').addEventListener('click', e => { if (e.target === $('members-modal')) closeMembers() })
$('connect-btn').addEventListener('click', async () => {
  clearLoginError()
  const ok = await window.heysureAPI.connect()
  if (!ok) {
    openLoginModal()
    showLoginError('请先登录账号后再连接 Agent')
    return
  }
  setStatus(await window.heysureAPI.getStatus())
})
$('disconnect-btn').addEventListener('click', async () => {
  await window.heysureAPI.disconnect()
  setReconnecting(false)
  setStatus(await window.heysureAPI.getStatus())
})

// ── Status / task events ──────────────────────────────────────────────────
window.heysureAPI.onStatusChange(setStatus)
window.heysureAPI.onActivityLog(() => { /* feed removed; stats tracked via task events */ })
window.heysureAPI.onTaskStart(() => { totalCalls++; runningCalls++; updateStats() })
window.heysureAPI.onTaskResult((data) => {
  runningCalls = Math.max(0, runningCalls - 1)
  data.success ? successCalls++ : failedCalls++
  updateStats()
})

// ── Login ──────────────────────────────────────────────────────────────────
const loginAccount  = $('login-account') as HTMLInputElement
const loginPassword = $('login-password') as HTMLInputElement
const loginRemember = $('login-remember') as HTMLInputElement
const loginBtn      = $('login-btn') as HTMLButtonElement
const loginError    = $('login-error')
const loginModal    = $('login-modal')

function showLoginError(msg: string) { loginError.textContent = msg; loginError.classList.add('visible') }
function clearLoginError() { loginError.classList.remove('visible') }
function openLoginModal() {
  loginModal.classList.remove('hidden'); clearLoginError()
  window.heysureAPI.getSettings().then(s => {
    loginAccount.value = s.userAccount || ''
    loginPassword.value = s.userPassword || ''
    loginRemember.checked = !!s.rememberLogin
    updateUserChip(s)
  }).catch(() => {})
}
function closeLoginModal() { loginModal.classList.add('hidden') }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLoginModal(); closeSettings(); closeMembers() } })

window.heysureAPI.onAuthExpired(async reason => {
  setReconnecting(false)
  const s = await window.heysureAPI.getSettings()
  updateUserChip(s); openLoginModal(); showLoginError(reason || '登录已过期，请重新登录')
})

// A silent re-login (using the saved credentials) succeeded — refresh the
// account chip and dismiss the login prompt if it was open. The orange prompt
// stays up until the socket re-registers (cleared in setStatus/onReconnecting).
window.heysureAPI.onAuthRefreshed(async () => {
  const s = await window.heysureAPI.getSettings()
  updateUserChip(s); closeLoginModal()
})

// Orange "reconnecting" prompt, driven by the main process so it reflects the
// real retry state (and never lingers for an intentional disconnect/logout).
window.heysureAPI.onReconnecting((active, reason) => setReconnecting(active, reason))

async function doLogin() {
  clearLoginError()
  const saved = await window.heysureAPI.getSettings()
  const serverUrl = (cfgServer.value.trim() || saved.serverUrl || '').trim()
  const account = loginAccount.value.trim()
  const password = loginPassword.value
  const remember = loginRemember.checked
  if (!serverUrl) { showLoginError('请先在设置中配置服务器地址'); return }
  if (!account) { showLoginError('请输入账号'); return }
  if (!password) { showLoginError('请输入密码'); return }
  loginBtn.disabled = true
  try {
    await window.heysureAPI.login({ serverUrl, account, password, remember })
    const s = await window.heysureAPI.getSettings()
    if (!remember) {
      loginPassword.value = ''
    }
    updateUserChip(s); closeLoginModal(); await loadMainSettings()
    window.heysureAPI.connect()
  } catch (err: any) {
    showLoginError(err.message || '登录失败')
  } finally {
    loginBtn.disabled = false
  }
}
loginBtn.addEventListener('click', doLogin)
;[loginAccount, loginPassword].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() }))
loginRemember.addEventListener('change', async () => {
  if (loginRemember.checked) return
  loginPassword.value = ''
  const s = await window.heysureAPI.getSettings()
  await window.heysureAPI.saveSettings({ userPassword: '', rememberLogin: false, userAccount: loginAccount.value.trim() || s.userAccount || '' })
})
$('login-modal-close').addEventListener('click', closeLoginModal)
loginModal.addEventListener('click', e => { if (e.target === loginModal) closeLoginModal() })

// ── Account / user chip ──────────────────────────────────────────────────
function resolveAvatarUrl(avatar: string, server: string): string {
  const raw = (avatar || '').trim(); if (!raw) return ''
  const base = (server || '').replace(/\/+$/, '')
  const preset = raw.match(/avatars([1-5])(?:[-.][^/]*)?\.png/i)
  if (preset) return base ? `${base}/avatars/avatars${preset[1]}.png` : ''
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw
  if (!base) return raw
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`
}
function bindAvatar(imgEl: HTMLImageElement, container: HTMLElement, src: string, fallback: string, textEl: HTMLElement) {
  textEl.textContent = fallback; container.classList.remove('has-image')
  imgEl.onload = null; imgEl.onerror = null
  if (!src) { imgEl.removeAttribute('src'); return }
  imgEl.onload = () => container.classList.add('has-image')
  imgEl.onerror = () => container.classList.remove('has-image')
  imgEl.src = src
}
function updateUserChip(s: any) {
  const authenticated = !!s.authToken
  const shown = String(s.userName || '').trim()
  const initial = shown ? shown.slice(0, 1).toUpperCase() : '·'
  const avatar = authenticated && shown ? (s.userAvatarDataUrl || resolveAvatarUrl(s.userAvatar || '', s.serverUrl || '')) : ''
  $('header-user-name').textContent = authenticated && shown ? shown : '未登录'
  bindAvatar($('header-user-ava-img') as HTMLImageElement, $('header-user-ava'), avatar, initial, $('header-user-ava-text'))
  if (authenticated && shown) {
    const host = (() => { try { return new URL(s.serverUrl).hostname } catch { return s.serverUrl || '—' } })()
    bindAvatar($('account-info-ava-img') as HTMLImageElement, $('account-info-ava'), avatar, initial, $('account-info-ava-text'))
    $('account-info-name').textContent = shown
    $('account-info-server').textContent = host
    $('account-info').style.display = 'flex'
    $('login-form').style.display = 'none'
  } else {
    $('account-info').style.display = 'none'
    $('login-form').style.display = 'flex'
  }
}
async function doLogout() {
  await window.heysureAPI.logout()
  const s = await window.heysureAPI.getSettings()
  cfgServer.value = s.serverUrl || ''
  loginAccount.value = s.userAccount || ''
  loginPassword.value = s.userPassword || ''
  loginRemember.checked = !!s.rememberLogin
  setReconnecting(false)
  updateUserChip(s); clearLoginError(); closeLoginModal(); setStatus('disconnected')
}
$('header-user-chip').addEventListener('click', openLoginModal)
$('logout-btn').addEventListener('click', doLogout)

// ── Settings load ──────────────────────────────────────────────────────────
async function loadMainSettings() {
  const s = await window.heysureAPI.getSettings()
  cfgServer.value = s.serverUrl || ''
  cfgWorkspace.value = s.workspaceRoot || ''
  cfgMouseFx.checked = s.mouseFx !== false
  cfgMouseScaleX.value = String(Number.isFinite(Number(s.mouseCoordinateScaleX)) ? Number(s.mouseCoordinateScaleX) : 1)
  cfgMouseScaleY.value = String(Number.isFinite(Number(s.mouseCoordinateScaleY)) ? Number(s.mouseCoordinateScaleY) : 1)
  renderStatus()
  $('info-server').textContent = s.serverUrl || '—'
  $('info-workspace').textContent = s.workspaceRoot ? (s.workspaceRoot.split(/[/\\]/).pop() || s.workspaceRoot) : '—'
  loginAccount.value = s.userAccount || ''
  loginPassword.value = s.userPassword || ''
  loginRemember.checked = !!s.rememberLogin
  updateUserChip(s)
  return s
}

// ── Init ─────────────────────────────────────────────────────────────────
async function init() {
  const s = await window.heysureAPI.getSettings()
  applyTheme(s.theme || 'dark', false)
  syncWindowMaxButton(await window.heysureAPI.isWindowMaximized())
  loginAccount.value = s.userAccount || ''
  loginPassword.value = s.userPassword || ''
  loginRemember.checked = !!s.rememberLogin
  await loadMainSettings()
  updateStats()
  await loadMcp()
  const status = await window.heysureAPI.getStatus()
  setStatus(status)
  if (s.authToken) window.heysureAPI.connect()
  else openLoginModal()
}
init().catch(console.error)
