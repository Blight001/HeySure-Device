// permission-guard — local second check before running a server-authored tool.
//
// The server already decides what an AI may call, but the device gets the final
// say (设备端MCP代码下放长期方案 §7.2 / §7.3): every tool declares permission
// tags, and the local policy maps each tag to allow / confirm / deny. A tool's
// effective decision is the strictest of its tags. "confirm" routes to a
// host-supplied dialog handler; with no handler registered the guard fails
// safe (denies) so an unattended device never silently runs a confirm-tier tool.

export type PermissionTag =
  | 'keyboard' | 'mouse'
  | 'clipboard.read' | 'clipboard.write'
  | 'screen.read'
  | 'window.read' | 'window.write'
  | 'filesystem.read' | 'filesystem.write'
  | 'process.read' | 'process.kill'
  | 'shell.read' | 'shell.write'
  | 'network'
  | 'browser.dom.read' | 'browser.dom.write'

export type PermissionDecision = 'allow' | 'confirm' | 'deny'

export type PermissionPolicy = Partial<Record<PermissionTag, PermissionDecision>>

// Defaults follow §7: read-only is allowed, writes/inputs need confirmation,
// destructive / privileged actions are denied unless the host loosens them.
const DEFAULT_POLICY: Record<PermissionTag, PermissionDecision> = {
  'keyboard': 'confirm',
  'mouse': 'confirm',
  'clipboard.read': 'allow',
  'clipboard.write': 'confirm',
  'screen.read': 'allow',
  'window.read': 'allow',
  'window.write': 'confirm',
  'filesystem.read': 'allow',
  'filesystem.write': 'confirm',
  'process.read': 'allow',
  'process.kill': 'deny',
  'shell.read': 'allow',
  'shell.write': 'confirm',
  'network': 'confirm',
  'browser.dom.read': 'allow',
  'browser.dom.write': 'confirm',
}

let policy: Record<string, PermissionDecision> = { ...DEFAULT_POLICY }

export interface ConfirmRequest {
  tool: string
  permissions: PermissionTag[]
  /** The tags that triggered the confirmation. */
  reasons: PermissionTag[]
  summary?: string
}

export type ConfirmHandler = (req: ConfirmRequest) => Promise<boolean>

let confirmHandler: ConfirmHandler | null = null

/** Merge overrides into the active policy (e.g. from server config). */
export function setPermissionPolicy(overrides: PermissionPolicy): void {
  policy = { ...policy, ...overrides }
}

export function resetPermissionPolicy(): void {
  policy = { ...DEFAULT_POLICY }
}

/** Host (main process) wires this to a confirm dialog. */
export function registerConfirmHandler(handler: ConfirmHandler | null): void {
  confirmHandler = handler
}

function decisionFor(tag: string): PermissionDecision {
  // Unknown tags are treated as confirm — safer than silently allowing.
  return policy[tag] ?? 'confirm'
}

const RANK: Record<PermissionDecision, number> = { allow: 0, confirm: 1, deny: 2 }

export interface PermissionResult {
  allowed: boolean
  decision: PermissionDecision
  /** Tags resolving to deny. */
  denied: PermissionTag[]
  /** Tags that needed (and, if allowed, received) confirmation. */
  confirmed: PermissionTag[]
  reason?: string
}

export interface PermissionCheckInput {
  tool: string
  permissions?: PermissionTag[]
  summary?: string
}

export async function checkPermissions(input: PermissionCheckInput): Promise<PermissionResult> {
  const permissions = (input.permissions || []) as PermissionTag[]
  const denied: PermissionTag[] = []
  const needsConfirm: PermissionTag[] = []
  let worst: PermissionDecision = 'allow'

  for (const tag of permissions) {
    const decision = decisionFor(tag)
    if (RANK[decision] > RANK[worst]) worst = decision
    if (decision === 'deny') denied.push(tag)
    else if (decision === 'confirm') needsConfirm.push(tag)
  }

  if (denied.length) {
    return { allowed: false, decision: 'deny', denied, confirmed: [], reason: `权限被拒绝: ${denied.join(', ')}` }
  }

  if (needsConfirm.length) {
    if (!confirmHandler) {
      return { allowed: false, decision: 'confirm', denied: [], confirmed: [], reason: '需要用户确认，但未注册确认处理器' }
    }
    const ok = await confirmHandler({
      tool: input.tool, permissions, reasons: needsConfirm, summary: input.summary,
    })
    return ok
      ? { allowed: true, decision: 'confirm', denied: [], confirmed: needsConfirm }
      : { allowed: false, decision: 'confirm', denied: [], confirmed: [], reason: '用户拒绝了本次操作' }
  }

  return { allowed: true, decision: worst, denied: [], confirmed: [] }
}
