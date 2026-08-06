'use strict';

const { limitAiControlMessages } = require('../../lib/ai-control-message-window');
const {
  findConnectionByReference,
  withBrowserRouteParam,
} = require('../../services/automation-tool-contract');

function createConnectionResolver(connections) {
  const findConnectionByRef = (ref) => {
    const resolved = findConnectionByReference(connections, ref);
    if (resolved.kind === 'found') return resolved.connection;
    if (resolved.kind === 'ambiguous') return { ambiguous: true, ref: resolved.reference };
    return null;
  };
  const describeConnections = () => connections
    .map((item) => `“${String(item.name || 'AI自动化浏览器')}”（change_browser: ${item.id}）`)
    .join('、');
  return { findConnectionByRef, describeConnections };
}

function collectConnectionTools(connections, windowTools) {
  const seenToolNames = new Set();
  const definitions = [];
  for (const item of connections) {
    for (const tool of (Array.isArray(item.tools) ? item.tools : [])) {
      const toolName = String(tool?.name || '');
      if (!toolName || windowTools?.has(toolName) || seenToolNames.has(toolName)) continue;
      seenToolNames.add(toolName);
      definitions.push(withBrowserRouteParam(tool));
    }
  }
  return definitions;
}

function appendDownloadWorkflow(workflow, available) {
  if (!available.has('browser_observe') || !available.has('browser_download')) return;
  workflow.push('用户要求寻找或下载文件时，先主动调用 browser_observe（可用 filter:"link"/"media" 或 keyword 收窄），从 item.downloadUrl 或顶层 downloadLinks[].url 取得真实地址和 downloadFilename/filename，再调用 browser_download action=download；下载图片/视频/音频时把条目的 category 传给 media_type，使工具使用当前 Chromium 登录态和网络环境；不得根据链接文字猜测下载地址');
}

function createMcpContext(tools, connections, resolver, controlledConnectionId) {
  if (!tools.length) return null;
  const availableNames = tools.map((tool) => String(tool?.name || '').trim()).filter(Boolean);
  const toolNames = availableNames.join('、');
  const available = new Set(availableNames);
  const controlled = connections.find((item) => String(item?.id || '') === String(controlledConnectionId || ''));
  const routing = connections.length > 1
    ? `可用连接：${resolver.describeConnections()}。当前只控制“${String(controlled?.name || controlled?.id || '未知')}”。AI 同一时间最多控制一个浏览器；要操作其他浏览器，必须在下一次浏览器工具调用中传 change_browser（连接 ID 或唯一名称），切换后后续调用沿用新目标。禁止同时控制多个目标或猜测目标。`
    : (connections.length === 1
      ? `当前唯一控制浏览器为 ${resolver.describeConnections()}；无需传 change_browser，除非之后出现新的可用连接。`
      : '当前没有可用的浏览器自动化连接，不要调用或虚构浏览器工具。');
  const workflow = [];
  if (available.has('browser_tab')) workflow.push('使用 browser_tab 确认、切换或导航标签页');
  if (available.has('browser_observe') && available.has('browser_action')) {
    workflow.push('网页操作前先用 browser_observe 获取当前状态，再用 browser_action 操作；导航、切换标签页或页面明显变化后重新 observe，禁止跨浏览器或跨页面复用旧 ref');
  } else if (available.has('browser_observe')) workflow.push('用 browser_observe 读取当前页面，不虚构未返回的元素');
  if (available.has('browser_wait')) workflow.push('仅在页面确实需要加载或等待元素时使用 browser_wait');
  appendDownloadWorkflow(workflow, available);
  if (available.has('sandbox_files')) {
    workflow.push('上传本地资产前先用 sandbox_files 列出 AI-Workspace，再把返回的 absolute_path 交给 browser_action.upload_file；浏览器下载也会自动保存到该工作区');
  }
  const browserWorkflow = workflow.length
    ? `${workflow.join('；')}。操作失败时根据错误调整策略，不要原样盲目重试。`
    : '';
  return {
    role: 'system',
    content: `你可以使用这些 AI-FREE MCP 工具：${toolNames}。${routing}${browserWorkflow}`
      + '只调用目录中真实存在的工具并严格遵守参数 schema。software_window 仅管理软件窗口：其 list 返回的 history_id 和 tab_id 不能当作 change_browser；窗口名称只有同时出现在可用连接列表时才能用于 change_browser。要聚焦已打开窗口，调用 software_window 的 open，并传 history_id 或唯一名称。'
      + 'browser_tab/browser_observe/browser_action/browser_wait 等浏览器工具只能控制当前目标，切换目标只能使用 change_browser；窗口已打开不等于其 MCP 已连接。'
      + 'software_window 的 open/create 会等待目标窗口的 Chromium 原生控制通道；只有返回 success=true、mcp_connected=true 和 control_browser_id 后才算可控，此时目标已自动切换，不要在连接就绪前调用页面工具。'
      + '当用户目标明确且操作安全时直接完成，不要为已知信息反复询问；涉及删除、覆盖、提交、支付或发送等重要动作时，以用户授权范围为准。'
      + '必须根据工具返回值判断下一步，未收到成功结果前不得声称操作完成；完成后用简洁自然语言说明实际结果，不要暴露内部调用格式。',
    ai_free_card_context: true,
  };
}

function buildChatToolContext(options = {}) {
  const { connections, controlledConnectionId, windowTools, selectedAutomationCard, automationCardId, initialMessages } = options;
  const resolver = createConnectionResolver(connections);
  const tools = [...(windowTools?.tools || []), ...collectConnectionTools(connections, windowTools)];
  const cardName = String(
    selectedAutomationCard?.cardName || selectedAutomationCard?.cardData?.name || automationCardId,
  ).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  const cardContext = selectedAutomationCard && connections.length
    ? {
      role: 'system',
      content: `AI 控制当前选中的自动化卡片名称为 ${JSON.stringify(cardName)}，ID 为 ${JSON.stringify(automationCardId.slice(0, 200))}。当用户要求查看、修改或运行当前卡片时，优先通过 manage_card 使用该 ID；不要擅自改用其他卡片。`,
      ai_free_card_context: true,
    }
    : null;
  const mcpContext = createMcpContext(tools, connections, resolver, controlledConnectionId);
  return {
    ...resolver,
    tools,
    modelMessages: limitAiControlMessages([
      ...(mcpContext ? [mcpContext] : []),
      ...(cardContext ? [cardContext] : []),
      ...initialMessages,
    ]),
  };
}

module.exports = { buildChatToolContext, createConnectionResolver, createMcpContext, withBrowserRouteParam };
