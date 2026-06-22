// popup/settings.ts — settings modal: load/apply persisted settings, save the
// server URL, the offline + mouse-fx toggles and the provider quick-presets.
// Login is fixed auto-connect, so there is no "auto-connect on startup" toggle.

import { AgentSettings } from '../lib/types'
import { state } from './state'
import { sendToBackground } from './transport'
import * as dom from './dom'
import { updateOfflineUi, applyTheme } from './ui'

export function loadSettings(s: AgentSettings) {
  state.serverUrl = s.serverUrl || ''
  dom.cfgServer.value   = s.serverUrl   || ''
  dom.cfgAiKey.value    = s.aiKey       || ''
  dom.cfgAiBase.value   = s.aiBaseUrl   || ''
  dom.cfgAiModel.value  = s.aiModel     || ''
  state.offlineMode = !!s.offlineMode
  dom.cfgOfflineMode.checked = state.offlineMode
  dom.cfgMouseFx.checked = s.mouseFx !== false
  state.localModel = s.aiModel || ''
  state.hasAiKey = !!(s.aiKey?.trim())
  updateOfflineUi()
  applyTheme(s.theme || 'dark', false)
}

// Provider quick-presets fill Base URL + a sensible default model.
const PROVIDER_PRESETS: Record<string, { base: string; model: string }> = {
  anthropic:  { base: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  openai:     { base: 'https://api.openai.com',    model: 'gpt-4o' },
  deepseek:   { base: 'https://api.deepseek.com',  model: 'deepseek-chat' },
  openrouter: { base: 'https://openrouter.ai/api', model: 'anthropic/claude-3.5-sonnet' },
  ollama:     { base: 'http://localhost:11434',    model: 'llama3.1' },
}

export function wireSettings() {
  dom.cfgAiProvider.addEventListener('change', () => {
    const p = PROVIDER_PRESETS[dom.cfgAiProvider.value]
    if (p) { dom.cfgAiBase.value = p.base; dom.cfgAiModel.value = p.model }
    dom.cfgAiProvider.value = ''
  })

  // Offline toggle persists immediately and updates the UI without a full save.
  dom.cfgOfflineMode.addEventListener('change', () => {
    state.offlineMode = dom.cfgOfflineMode.checked
    updateOfflineUi()
    sendToBackground({ type: 'settings:save', payload: { offlineMode: state.offlineMode } })
  })

  // Mouse-effect toggle persists immediately; content scripts react via storage.
  dom.cfgMouseFx.addEventListener('change', () => {
    sendToBackground({ type: 'settings:save', payload: { mouseFx: dom.cfgMouseFx.checked } })
  })

  dom.saveBtn.addEventListener('click', () => {
    const payload: Partial<AgentSettings> = {
      serverUrl:   dom.cfgServer.value.trim(),
      aiKey:       dom.cfgAiKey.value.trim(),
      aiBaseUrl:   dom.cfgAiBase.value.trim() || 'https://api.anthropic.com',
      aiModel:     dom.cfgAiModel.value.trim() || 'claude-sonnet-4-5',
      offlineMode: dom.cfgOfflineMode.checked,
      mouseFx:     dom.cfgMouseFx.checked,
    }
    state.serverUrl = payload.serverUrl || ''
    state.offlineMode = !!payload.offlineMode
    state.localModel = payload.aiModel || ''
    state.hasAiKey = !!(payload.aiKey)
    sendToBackground({ type: 'settings:save', payload })
    updateOfflineUi()
    dom.saveFeedback.textContent = '已保存 ✓'
    dom.saveFeedback.style.color = 'var(--success)'
    setTimeout(() => { dom.saveFeedback.textContent = '' }, 2000)
  })
}
