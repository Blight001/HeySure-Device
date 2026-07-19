// permission-guard — local second check before running a server-authored tool.
//
// 7×24 全自动项目：默认策略全部 allow，本地不再有确认弹窗环节。机制本身保留：
// 每个工具仍声明 permission 标签，取最严格标签为最终裁决；服务器可经
// device:tool-config 的 permissionPolicy 显式下发 confirm / deny 收紧。
// "confirm" 仍路由到宿主对话框处理器（未注册处理器时拒绝），但默认策略下
// 不会触发。

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

// 7×24 全自动运行项目：默认全部放行，不设确认环节（原"写入/输入需确认、
// 危险操作拒绝"的默认已按产品决策移除）。服务器仍可经 device:tool-config 的
// permissionPolicy 显式下发 confirm/deny 收紧——机制保留，默认不触发。
const DEFAULT_POLICY: Record<PermissionTag, PermissionDecision> = {
  'keyboard': 'allow',
  'mouse': 'allow',
  'clipboard.read': 'allow',
  'clipboard.write': 'allow',
  'screen.read': 'allow',
  'window.read': 'allow',
  'window.write': 'allow',
  'filesystem.read': 'allow',
  'filesystem.write': 'allow',
  'process.read': 'allow',
  'process.kill': 'allow',
  'shell.read': 'allow',
  'shell.write': 'allow',
  'network': 'allow',
  'browser.dom.read': 'allow',
  'browser.dom.write': 'allow',
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
  // 全自动项目：未知标签也默认放行（服务器可显式下发策略收紧）。
  return policy[tag] ?? 'allow'
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
