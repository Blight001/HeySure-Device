// popup/state.ts — shared mutable state for the popup UI.
// The popup is a single bundled IIFE; every feature module reads and writes
// this one `state` singleton instead of passing values around. Treat it as the
// popup's in-memory store. Account, status, settings and the AI member list are
// surfaced via modals.

import { DeviceStatus } from '../lib/types'
import { AuthState } from '../lib/storage'
import { MemberConfig } from '../lib/client'

export const state = {
  currentTheme: 'dark' as 'dark' | 'light',
  currentStatus: 'disconnected' as DeviceStatus,
  // Server-side bound AI for this device (from device:registered). null = none
  // assigned yet → status indicator shows yellow instead of green.
  boundAiConfigId: null as number | null,
  hasAiKey: false,
  // Assigned in initPort(); listeners that read it only fire after init.
  port: undefined as unknown as chrome.runtime.Port,

  serverUrl: '',
  offlineMode: false,
  localModel: '',
  auth: { token: '', account: '', password: '', rememberLogin: false, userId: null, userName: '', avatar: '' } as AuthState,
  // Cached data URL for the current account's avatar (hydrated from storage).
  avatarDataUrl: '',
  members: [] as MemberConfig[],

  // ── Tool-call statistics (this popup session) ──
  stats: { total: 0, running: 0, success: 0, failed: 0 },

  // ── MCP tool page view state ──
  // Currently opened tool name in the detail view, or null for the list.
  openToolName: null as string | null,
  // Pending mcp:test requestId → resolver, so the detail view can await a run.
  pendingTests: new Map<string, (r: { ok: boolean; result?: any; error?: string }) => void>(),
}
