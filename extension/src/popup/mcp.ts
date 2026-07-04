// popup/mcp.ts — the popup's main area: the browser MCP tool page.
// Lists this extension's own MCP tools; opening one shows description, params,
// editable local descriptions and a direct local test runner.

import {
  BROWSER_TOOL_CATEGORIES, BROWSER_TOOL_KIND_LABELS,
  BrowserToolCategory, BrowserToolKind, allToolDefs, browserToolKind,
  isServerManagedToolDef, DYNAMIC_MCP_SERVER_SESSION_KEY,
} from '../lib/tools'
import { AIToolDef } from '../lib/types'
import {
  getToolDescOverrides, setToolDescOverride,
} from '../lib/storage'
import * as dom from './dom'
import { state } from './state'
import { sendToBackground } from './transport'
import { renderToolDemo } from './mcp-demos'

let overrides: Record<string, { description?: string; parameters?: Record<string, string> }> = {}
let currentToolDefs: AIToolDef[] = []
let currentCategories: BrowserToolCategory[] = BROWSER_TOOL_CATEGORIES
const expandedKinds = new Set<BrowserToolKind>()

const KIND_META: Record<BrowserToolKind, { zh: string; en: string }> = {
  basic: { zh: '基础类', en: 'BASIC' },
  special: { zh: '特殊类', en: 'SPECIAL' },
}

const CATEGORY_META: Record<string, { zh: string; en: string }> = {
  '导航与搜索': { zh: '导航与搜索', en: 'NAVIGATION' },
  '页面观察': { zh: '页面观察', en: 'OBSERVATION' },
  '页面交互': { zh: '页面交互', en: 'INTERACTION' },
  '数据与脚本': { zh: '数据与脚本', en: 'DATA & SCRIPT' },
  '浏览器状态': { zh: '浏览器状态', en: 'BROWSER STATE' },
  'MCP 动态管理': { zh: 'MCP 动态管理', en: 'DYNAMIC MCP' },
}

const TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  browser_observe: { zh: '页面观察', en: 'Observe' },
  browser_screenshot: { zh: '页面截图', en: 'Screenshot' },
  browser_action: { zh: '页面交互（点击/滚动/输入/按键）', en: 'Page Action' },
  browser_wait: { zh: '等待页面', en: 'Wait' },
  browser_drag: { zh: '拖拽元素', en: 'Drag' },
  browser_evaluate: { zh: '执行脚本', en: 'Evaluate Script' },
  browser_extract: { zh: '提取数据', en: 'Extract Data' },
  browser_clipboard_write: { zh: '写入剪贴板', en: 'Write Clipboard' },
  browser_file_upload: { zh: '上传文件', en: 'File Upload' },
  browser_download: { zh: '下载文件', en: 'Download' },
  browser_tab: { zh: '标签页（list/switch/replace/navigate）', en: 'Tab Management' },
  browser_cookie: { zh: '管理 Cookie', en: 'Cookie Manager' },
  browser_storage: { zh: '管理存储', en: 'Storage Manager' },
  browser_session: { zh: '管理会话', en: 'Session Manager' },
  'browser_mcp.manage_dynamic_tool': { zh: '管理动态 MCP', en: 'Dynamic MCP Manager' },
}

function esc(str: string) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function toTitleCase(value: string) {
  return String(value)
    .replace(/^browser[_-]?/i, '')
    .replace(/[._-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function toolMeta(name: string) {
  const fallback = toTitleCase(name)
  return TOOL_LABELS[name] || { zh: fallback, en: fallback }
}

function categoryMeta(title: string) {
  return CATEGORY_META[title] || { zh: title, en: toTitleCase(title).toUpperCase() }
}

function isEdited(tool: AIToolDef) {
  if (isServerManagedToolDef(tool)) return false
  const o = overrides[tool.name]
  return !!(o && (o.description || (o.parameters && Object.keys(o.parameters).length)))
}

function effDescription(t: AIToolDef) {
  if (isServerManagedToolDef(t)) return t.description || ''
  return overrides[t.name]?.description?.trim() || t.description || ''
}

function effParamDesc(tool: AIToolDef, param: string, raw: string) {
  if (isServerManagedToolDef(tool)) return raw || ''
  return overrides[tool.name]?.parameters?.[param]?.trim() || raw || ''
}

function paramEntries(t: AIToolDef) {
  const props = t.input_schema?.properties || {}
  const required = new Set(t.input_schema?.required || [])
  return Object.keys(props).map(p => {
    const cfg = (props as any)[p] || {}
    const ty = Array.isArray(cfg.type) ? cfg.type.join('|') : (cfg.type || 'any')
    return { name: p, type: String(ty), required: required.has(p), desc: String(cfg.description || '') }
  })
}

export async function renderMcpList() {
  state.openToolName = null
  dom.mcpDetailPane.classList.add('hidden')
  dom.mcpListPane.classList.remove('hidden')
  overrides = await getToolDescOverrides()
  currentToolDefs = await allToolDefs()
  const categorized = new Set(BROWSER_TOOL_CATEGORIES.flatMap(category => category.tools))
  const dynamicTools = currentToolDefs.map(tool => tool.name).filter(name => !categorized.has(name))
  currentCategories = dynamicTools.length
    ? [...BROWSER_TOOL_CATEGORIES, { title: 'MCP 动态管理', kind: 'special', tools: dynamicTools }]
    : BROWSER_TOOL_CATEGORIES
  dom.mcpCount.textContent = `${currentToolDefs.length} 个 · ${currentCategories.length} 组`
  dom.mcpList.innerHTML = ''
  const byName = new Map(currentToolDefs.map(t => [t.name, t]))

  // Group by kind (基础类 / 特殊类), then by category. No per-tool enable toggles
  // (MCPs are server-issued; call permission is governed server-side).
  const kinds: BrowserToolKind[] = ['basic', 'special']
  for (const kind of kinds) {
    const cats = currentCategories.filter(c => c.kind === kind)
    if (!cats.length) continue
    const kindTools = cats.flatMap(c => c.tools).filter(n => byName.has(n))
    // 纯服务器驱动下，未连接/服务器未下发前某些分类可能一个工具都没有——
    // 跳过空栏目，避免渲染出 0/0 的空「基础类」。
    if (!kindTools.length) continue
    const expanded = expandedKinds.has(kind)
    const meta = KIND_META[kind]

    const parent = document.createElement('details')
    parent.className = 'mcp-parent'
    parent.dataset.kind = kind
    parent.open = expanded
    parent.innerHTML = `
      <summary>
        <span class="mcp-parent-summary-left">
          <span class="mcp-chevron"></span>
          <span class="mcp-parent-labels">
            <span class="mcp-parent-zh">${esc(meta.zh)}</span>
            <span class="mcp-parent-en">${esc(meta.en)}</span>
          </span>
        </span>
        <span class="mcp-parent-count">${kindTools.length} 个</span>
      </summary>
      <div class="mcp-parent-body"></div>`
    parent.addEventListener('toggle', () => {
      parent.open ? expandedKinds.add(kind) : expandedKinds.delete(kind)
    })
    const body = parent.querySelector('.mcp-parent-body') as HTMLElement

    for (const cat of cats) {
      const tools = cat.tools.map(n => byName.get(n)).filter((t): t is AIToolDef => !!t)
      if (!tools.length) continue
      const cMeta = categoryMeta(cat.title)
      const group = document.createElement('section')
      group.className = 'mcp-group'
      group.innerHTML = `
        <div class="mcp-group-title">
          <span class="mcp-group-zh">${esc(cMeta.zh)}</span>
          <span class="mcp-group-en">${esc(cMeta.en)}</span>
          <span class="mcp-group-count">${tools.length} 个</span>
        </div>
        <div class="mcp-group-items"></div>`
      const items = group.querySelector('.mcp-group-items') as HTMLElement
      for (const t of tools) {
        const tMeta = toolMeta(t.name)
        const el = document.createElement('div')
        el.className = 'tool-item'
        el.innerHTML = `
          <div class="tool-item-top">
            <div class="tool-title">
              <span class="tool-name">${esc(tMeta.zh)}</span>
              <span class="tool-name-sub">${esc(tMeta.en)}</span>
            </div>
            ${isServerManagedToolDef(t) ? '<span class="tool-edited">服务器</span>' : ''}
            ${isEdited(t) ? '<span class="tool-edited">已自定义</span>' : ''}
          </div>
          <div class="tool-desc">${esc((effDescription(t) || '（无描述）').slice(0, 110))}</div>`
        el.addEventListener('click', () => void openTool(t.name))
        items.appendChild(el)
      }
      body.appendChild(group)
    }
    dom.mcpList.appendChild(parent)
  }
}

async function openTool(name: string) {
  const tool = currentToolDefs.find(t => t.name === name) || (await allToolDefs()).find(t => t.name === name)
  if (!tool) return
  state.openToolName = name
  dom.mcpListPane.classList.add('hidden')
  dom.mcpDetailPane.classList.remove('hidden')
  dom.mcpDetail.scrollTop = 0
  await renderDetail(tool)
}

async function renderDetail(tool: AIToolDef) {
  overrides = await getToolDescOverrides()
  const category = currentCategories.find(item => item.tools.includes(tool.name))
  const kind = category?.kind || browserToolKind(tool.name)
  const meta = toolMeta(tool.name)
  const params = paramEntries(tool)
  const serverManaged = isServerManagedToolDef(tool)
  const paramHtml = params.length
    ? params.map(p => `
        <div class="param-row">
          <div class="param-head">
            <span class="param-name">${esc(p.name)}</span>
            <span class="param-type">${esc(p.type)}</span>
            ${p.required ? '<span class="param-req">必填</span>' : ''}
          </div>
          <div class="tool-desc">${esc(effParamDesc(tool, p.name, p.desc) || '（无说明）')}</div>
          ${serverManaged ? '' : `<input type="text" data-param="${esc(p.name)}" class="edit-param" placeholder="自定义参数说明（留空用默认）" value="${esc(overrides[tool.name]?.parameters?.[p.name] || '')}" style="margin-top:5px;"/>`}
        </div>`).join('')
    : '<div class="empty-note">该工具无参数</div>'
  const editCard = serverManaged
    ? `<div class="card">
      <div class="card-title">服务器管理</div>
      <div class="login-hint">此工具的 schema 由服务器工作区 <code>device_tools/browser/</code> 下发，与 Windows 桌面一致。请在 Web 控制台或工作区文件中修改描述与参数说明。</div>
    </div>`
    : `<div class="card">
      <div class="card-title">编辑描述（本地保存，随上报同步给服务器）</div>
      <div class="fg"><label>工具描述（用途 + 使用场景）</label>
        <textarea class="ta" id="edit-desc" placeholder="留空使用默认描述">${esc(overrides[tool.name]?.description || '')}</textarea>
      </div>
      <button class="btn btn-primary" id="edit-save">保存描述</button>
      <button class="btn btn-secondary" id="edit-reset">恢复默认</button>
      <div class="save-feedback" id="edit-feedback"></div>
    </div>`
  const argTemplate = JSON.stringify(Object.fromEntries(params.filter(p => p.required).map(p => [p.name, ''])), null, 2)

  dom.mcpDetail.innerHTML = `
    <div class="card">
      <div class="tool-title-row">
        <div class="tool-title-stack">
          <div class="tool-title-main">${esc(meta.zh)}</div>
          <div class="tool-title-sub">${esc(meta.en)}</div>
        </div>
        <div class="tool-title-id">${esc(tool.name)}</div>
      </div>
      <div class="tool-desc" style="font-size:11px;">${esc(effDescription(tool) || '（无描述）')}</div>
      <span class="tool-kind-tag ${kind}">${esc(BROWSER_TOOL_KIND_LABELS[kind])} · ${esc(category?.title || '未分类')}</span>
    </div>
    ${renderToolDemo(tool.name)}
    <div class="card">
      <div class="card-title">参数说明</div>
      ${paramHtml}
    </div>
    ${editCard}
    <div class="card">
      <div class="card-title">测试调用 (mcp.test)</div>
      <div class="login-hint">在当前浏览器环境直接执行该工具并返回原始结果。</div>
      <div class="fg"><label>参数 (JSON)</label>
        <textarea class="ta" id="test-args" style="min-height:70px;font-family:'Cascadia Code',Consolas,monospace;">${esc(argTemplate)}</textarea>
      </div>
      <button class="btn btn-primary" id="test-run">测试</button>
      <div class="test-result" id="test-result" style="display:none;"></div>
    </div>`

  if (!serverManaged) {
    dom.mcpDetail.querySelector('#edit-save')!.addEventListener('click', async () => {
      const description = (dom.mcpDetail.querySelector('#edit-desc') as HTMLTextAreaElement).value
      const parameters: Record<string, string> = {}
      dom.mcpDetail.querySelectorAll<HTMLInputElement>('.edit-param').forEach(inp => {
        parameters[inp.dataset.param!] = inp.value
      })
      await setToolDescOverride(tool.name, { description, parameters })
      sendToBackground({ type: 'device:connect' })
      const fb = dom.mcpDetail.querySelector('#edit-feedback') as HTMLElement
      fb.textContent = '已保存，稍后同步给服务器'
      fb.style.color = 'var(--success)'
      await renderDetail(tool)
    })

    dom.mcpDetail.querySelector('#edit-reset')!.addEventListener('click', async () => {
      await setToolDescOverride(tool.name, { description: '', parameters: {} })
      sendToBackground({ type: 'device:connect' })
      await renderDetail(tool)
    })
  }

  dom.mcpDetail.querySelector('#test-run')!.addEventListener('click', () => {
    const out = dom.mcpDetail.querySelector('#test-result') as HTMLElement
    let args: Record<string, any> = {}
    const raw = (dom.mcpDetail.querySelector('#test-args') as HTMLTextAreaElement).value.trim()
    if (raw) {
      try { args = JSON.parse(raw) } catch (e: any) {
        out.style.display = 'block'; out.className = 'test-result fail'; out.textContent = `参数 JSON 解析失败：${e?.message || e}`; return
      }
    }
    out.style.display = 'block'; out.className = 'test-result'; out.textContent = '执行中…'
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    state.pendingTests.set(requestId, r => {
      if (r.ok) {
        out.className = 'test-result ok'
        out.textContent = '成功\n' + safeStringify(r.result)
      } else {
        out.className = 'test-result fail'
        out.textContent = '失败：' + (r.error || '未知错误')
      }
    })
    sendToBackground({ type: 'mcp:test', requestId, tool: tool.name, args })
  })
}

function safeStringify(v: any): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) } catch { return String(v) }
}

// Called by index.ts when an mcp:test:result message arrives.
export function resolveTest(requestId: string, r: { ok: boolean; result?: any; error?: string }) {
  const fn = state.pendingTests.get(requestId)
  if (!fn) return
  state.pendingTests.delete(requestId)
  fn(r)
}

export function wireMcp() {
  dom.mcpBack.addEventListener('click', () => void renderMcpList())
  // Server-pushed tools arrive asynchronously in the background and are shared
  // via chrome.storage.session. Re-render when they change so a popup opened
  // before/during the server push still fills in — but not while the user is
  // reading a tool's detail (that would kick them back to the list).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[DYNAMIC_MCP_SERVER_SESSION_KEY] && state.openToolName === null) {
      void renderMcpList()
    }
  })
}
