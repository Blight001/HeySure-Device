// popup/dom.ts — cached DOM element references.
// popup.js runs after the document is parsed, so these lookups resolve once at
// module-evaluation time and are reused everywhere.

const $ = (id: string) => document.getElementById(id)!

// Header
export const statusDot    = $('status-dot')
export const statusLabel  = $('status-label')
export const statusPill   = $('status-pill')
export const themeToggle  = $('theme-toggle')
export const settingsBtn  = $('settings-btn')
export const offlineChatBtn = $('offline-chat-btn') as HTMLButtonElement
export const userChip     = $('user-chip')
export const userAva      = $('user-ava')
export const userName     = $('user-name')

// MCP tool page
export const mcpListPane   = $('mcp-list-pane')
export const mcpDetailPane = $('mcp-detail-pane')
export const mcpList       = $('mcp-list')
export const mcpCount      = $('mcp-count')
export const mcpDetail     = $('mcp-detail')
export const mcpBack       = $('mcp-back')

// Settings modal
export const settingsModal = $('settings-modal')
export const settingsClose = $('settings-close')
export const cfgServer     = $('cfg-server')  as HTMLInputElement
export const cfgAiKey      = $('cfg-ai-key')  as HTMLInputElement
export const cfgAiBase     = $('cfg-ai-base') as HTMLInputElement
export const cfgAiModel    = $('cfg-ai-model') as HTMLInputElement
export const cfgOfflineMode = $('cfg-offline-mode') as HTMLInputElement
export const offlineModelConfig = $('offline-model-config')
export const cfgAiProvider = $('cfg-ai-provider') as HTMLSelectElement
export const cfgMouseFx    = $('cfg-mouse-fx') as HTMLInputElement
export const nativeBridgeCard = $('native-bridge-card')
export const cfgNativeBridgeUrl = $('cfg-native-bridge-url') as HTMLInputElement
export const testNativeBridge = $('test-native-bridge') as HTMLButtonElement
export const nativeBridgeFeedback = $('native-bridge-feedback')
export const saveBtn       = $('save-btn') as HTMLButtonElement
export const saveFeedback  = $('save-feedback')

// Stats
export const statTotal    = $('stat-total')
export const statRunning  = $('stat-running')
export const statSuccess  = $('stat-success')
export const statFailed   = $('stat-failed')

// Members modal
export const membersModal = $('members-modal')
export const membersModalClose = $('members-modal-close')
export const connectionStatusV = $('connection-status-v')
export const aiStatusV = $('ai-status-v')
export const serverStatusV = $('server-status-v')
export const connectBtn   = $('connect-btn')
export const disconnectBtn = $('disconnect-btn')

// Login modal
export const loginModal   = $('login-modal')
export const loginModalClose = $('login-modal-close')
export const loginGate    = $('login-gate')
export const accountCard  = $('account-card')
export const accountStatusV = $('account-status-v')
export const loginAccount = $('login-account') as HTMLInputElement
export const loginPassword = $('login-password') as HTMLInputElement
export const loginRemember = $('login-remember') as HTMLInputElement
export const loginBtn     = $('login-btn') as HTMLButtonElement
export const loginFeedback = $('login-feedback')
export const logoutBtn    = $('logout-btn') as HTMLButtonElement
