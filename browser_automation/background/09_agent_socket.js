// 09_agent_socket.js — HeySure 服务器同步连接（登录后自动连接 + 设备登记 + AI 分配 + 任务调度）
// 与 device/extension/src/lib/background.ts 对齐：登录拿到 agent_socket_url 后建立 Socket.IO
// 连接，使用 DEVICE_ENROLL 上报本设备与工具目录；服务器（网页端「作坊」）为本设备分配 AI，
// 之后 AI 触发的工具调用经 Connector Runtime 以 task:dispatch 下发到这里执行。
//
// 依赖：vendor/socket.io.js 提供的全局 io（importScripts 顺序保证其先加载）；
//       08_agent_auth.js 的登录/设置读写；00-07 的自动化卡片 / Cookie 抓取实现。

const AGENT_KEEPALIVE_ALARM = 'agent-keepalive';
const AGENT_VERSION = '1.0.0';

// Protocol event names (kept for server compatibility)
const DEVICE_ENROLL = 'device:register';
const DEVICE_ENROLLED = 'device:registered';
const DEVICE_ENROLL_REJECTED = 'device:register_rejected';

let agentSocket = null;
let agentStatus = 'disconnected'; // disconnected | connecting | connected | enrolled | error
let agentBoundAiConfigId = null;
let agentCurrentId = null;
let agentMachineId = null;
let agentAuthRejected = false;
let agentConnectPromise = null;
let agentLastErrorReason = ''; // 最近一次 error 状态的原因，便于 UI 显示详细提示
const agentTaskOutcomes = new Map();
const MAX_AGENT_TASK_OUTCOMES = 100;

// 用于 MCP / agent 调用 manage_card run 时，将 card-run-progress 实时转发为 task:progress
let activeMcpCardTask = null;

// ── 自动化卡片编写规范（manage_card action=rules 返回给 AI）───────────────────
// 与 06_automation_run.js 执行引擎、02_sidebar_page.js 页面动作执行器、
// popup/automation-workbench.js 编辑器保持一致；改动步骤类型或字段时同步更新这里。
// 注意：type 步骤现已显式支持 textarea（根因修复百度等站点改版后 #kw -> textarea 失效）。

// 执行引擎实际支持的步骤类型全集（write 校验与 rules 均以此为准）。
const CARD_STEP_TYPES = [
    'navigate', 'click', 'type', 'wait',
    'save_cookies', 'clear_current_page_cache', 'get_credits', 'external_script', 'screenshot'
];
const CARD_STEP_BY_VALUES = ['css_selector', 'text', 'auto'];

const CARD_FORMAT_RULES = `# 自动化卡片规范（cardData）—— 步骤类型与运行规则

写卡片前必读。字段与步骤类型只能取自本规范，不要发明不存在的字段或类型（write 时会校验并拒绝）。

## 顶层字段
- name: string，卡片名称（为空时自动生成 automation_<时间戳>）
- website: string，目标网址；若 steps 第一步不是 navigate，执行时会自动在最前插入跳转到 website 的 navigate 步骤
- description: string，可选，卡片说明
- points: number，可选，积分基础值
- popups: array，可选，弹窗关闭规则，形如 [{ "name": "关闭弹窗", "selector": ".modal-close" }]
- steps: array，必填且非空，按顺序执行

## 步骤通用字段
- name: string，步骤名（仅用于展示/日志，不再影响填充逻辑）
- type: string，必填，只能取下方 10 种步骤类型之一
- selector: string，目标元素定位，语法见「选择器语法」
- text: string，type 步骤要输入的默认文本（即变量默认值，见运行规则第 4 条「变量输入」）
- variable: string，可选，仅 type 步骤有效；该变量的键名，运行前可用 inputs 按此键覆盖输入文本；不填则按其在全部 type 步骤中的顺序回退为 var1/var2/...
- by: "css_selector"（默认）| "text"（按可见文本）| "auto"（先按 CSS 再按文本兜底）
- nth: number，可选，selector 命中多个元素时取第几个
- timeout: number，毫秒，可选，默认值见各步骤类型
- poll_interval_ms: number，毫秒，可选，轮询间隔
- optional: true 时该步骤失败直接跳过；不设置则非等待步骤失败后不重试（等待步骤最多重试 3 次，见运行规则第 2 条）

## 步骤类型（type，仅以下 9 种）
- navigate: 跳转 url（省略 url 时用卡片 website；当前已在目标地址则跳过跳转；timeout 默认 5000）
- click: 点击 selector 元素（timeout 默认 5000，poll_interval_ms 默认 200）
- type: 向 selector 输入 text（支持 <input>（非 button/checkbox 等）、<textarea>、[contenteditable]、role=textbox/searchbox 等可编辑元素；timeout 默认 5000）；clear_first=true 输入前清空；click_before_type=true 输入前先点击。找到非输入元素会立即报错（失败后不重试）
- wait: 等待元素出现（selector + timeout，默认 3000）；或改用 wait_for_text 等文本出现 / wait_for_element_hidden 等元素消失 / wait_for_text_hidden 等文本消失
- save_cookies: 抓取并保存当前页 Cookie + localStorage/sessionStorage（必须显式放在 steps 里才会执行；缺少 account/password 上下文时该步跳过并在进度中记录原因）
- clear_current_page_cache: 清理当前页 Cookie/localStorage/sessionStorage/CacheStorage/IndexedDB
- get_credits: 读取 selector 元素文本作为积分写入执行结果
- external_script: 在页面上下文执行 script 字段中的 JS 代码（CSP 严格站点可能被拦截，此时建议使用 browser_action 或调整卡片避免依赖 eval）
- screenshot: 截图步骤（当前实现会捕获当前标签页可见区域并下载 PNG）

## 选择器语法（selector）
- 标准 CSS：#id、.class、button[type=submit]
- text=登录 —— 按可见文本定位
- id=xxx / class=xxx / name=xxx / placeholder=xxx / aria-label=xxx —— 按属性定位
- .btn:has-text("提交") —— CSS 命中且内含指定文本
- by="auto" 时先按 CSS 查找，找不到再自动按 text= 兜底

## 模板变量
url/selector/text/script/wait_for_* 等字符串字段支持占位符 {键}，执行时替换为运行上下文的值；未知占位符原样保留。可用的键：任意「变量键」（每个 type 步骤的 variable，或 var1/var2/...，取其最终输入值）和运行前 inputs 传入的键。不再有账号/密码专属占位符或随机密码。

## 运行规则（执行行为，写卡片时必须据此设计步骤）
1. 卡片在当前活动标签页执行；入口地址取第一步 navigate 的 url，否则取卡片 website（两者都没有则 write 会被拒绝）。
2. 等待（wait）类型的非 optional 步骤失败后最多重试 3 次（间隔约 2 秒），其他步骤类型失败后不进行反复尝试（直接失败并结束）；对可能不存在的元素（如偶现弹窗、可选勾选框）必须加 optional:true。
3. 变量输入（替代原账号/密码机制）：每个 type 步骤都是一个变量槽，默认输入其 text 字段的固定文本。运行前可通过 run(payload) 的 inputs（{ 变量键: 值 } 对象或数组按序映射 var1..varN）或注册面板输入框按变量键覆盖该步骤的输入文本；未提供覆盖值则用 text 默认值。变量键取步骤 variable 字段，未设置则按其在全部 type 步骤中的顺序回退为 var1/var2/...。不再自动生成密码。
4. 不再有基于步骤名的智能填充。需要运行期赋值的输入，用自定义变量键 + inputs 覆盖。type 支持的元素类型见「步骤类型」说明，命中非输入元素会立即清晰报错。
5. Cookie 保存不是自动行为，必须在 steps 中主动加入 { "type": "save_cookies", "name": "保存 Cookie" } 步骤才会执行抓取并保存当前页的 Cookie + localStorage/sessionStorage。显式步骤中若缺少 account/password 上下文则会跳过保存并记录原因。文件名优先使用 account/password（或 email/code）变量值。
6. 同一时间只能运行一张卡片；action=run 是长任务，可能耗时数分钟。执行期间会通过 task:progress 及时反馈每步开始/完成/重试/错误等完整过程，而非仅返回最终结果。
7. 失败结果与续跑闭环：run 失败时返回 errorCode（ELEMENT_NOT_FOUND / WAIT_TIMEOUT / NAVIGATION_TIMEOUT / UNSUPPORTED_ELEMENT_TYPE / SCRIPT_ERROR / VERIFICATION_CODE_TIMEOUT / CLICK_FAILED / MISSING_URL 等）、失败步骤 stepIndex/stepName/stepType/selector、failureSnapshot（当前页 URL/标题 + 近似候选元素的 tag/selector/text/placeholder）与 context（已用到的变量值，如 account/password/email/code 或自定义键）。失败后页面停留在失败现场：先按 failureSnapshot.candidates 或 browser_observe 找出正确 selector，用 write 修复卡片，再 run + start_step=失败的 stepIndex（并通过 inputs 回传 context 里已用到的变量值）从失败步骤继续，不要从头重跑。另外 browser_action click/type、browser_tab navigate/replace、browser_wait 成功回执都带 cardStep 字段（与本规范同构的步骤对象）——探索验证通过后直接把这些 cardStep 拼进 steps 即可成卡，type 步骤的 text 即该变量默认值（需运行期赋值的写成 {code} 或自定义变量键）；cardStep.inFrame=true 时该 selector 在 iframe 内，不能直接写入卡片。

## 最小示例
{
  "name": "示例注册",
  "website": "https://example.com/signup",
  "steps": [
    { "name": "输入邮箱", "type": "type", "selector": "#email", "variable": "email", "text": "test@example.com" },
    { "name": "输入密码", "type": "type", "selector": "#password", "variable": "password", "text": "MyPassw0rd!" },
    { "name": "同意条款", "type": "click", "selector": "#agree", "optional": true },
    { "name": "提交", "type": "click", "selector": "button[type=submit]" }
  ]
}
// 运行时覆盖示例：inputs = { "email": "user01@x.com", "password": "P@ss01" }（未传的变量用上面的默认 text）`;

// write 前置校验：拦截 AI 编造的步骤类型/定位方式，错误信息直接指回 action=rules。
function validateCardDataForWrite(cardData) {
    if (!cardData || typeof cardData !== 'object' || Array.isArray(cardData)) {
        throw new Error('cardData 必须是对象；请先调用 manage_card action=rules 获取卡片规范');
    }
    const steps = Array.isArray(cardData.steps) ? cardData.steps : [];
    if (steps.length === 0) {
        throw new Error('cardData.steps 必须是非空数组；请先调用 manage_card action=rules 获取卡片规范');
    }
    const problems = [];
    steps.forEach((step, index) => {
        const label = `steps[${index}]${step && step.name ? `（${step.name}）` : ''}`;
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
            problems.push(`${label} 不是对象`);
            return;
        }
        const type = String(step.type || '').trim().toLowerCase();
        if (!CARD_STEP_TYPES.includes(type)) {
            problems.push(`${label} 的 type "${step.type || '(空)'}" 不存在`);
        }
        if (step.by !== undefined && !CARD_STEP_BY_VALUES.includes(String(step.by).trim().toLowerCase())) {
            problems.push(`${label} 的 by "${step.by}" 不存在（可选 ${CARD_STEP_BY_VALUES.join('/')}）`);
        }
    });
    if (problems.length > 0) {
        throw new Error(`卡片校验失败：${problems.join('；')}。合法步骤类型仅限 ${CARD_STEP_TYPES.join('/')}，请调用 manage_card action=rules 查看完整规范后修正再写入。`);
    }
    const firstStep = steps.find((step) => step && typeof step === 'object');
    const firstType = String((firstStep && firstStep.type) || '').trim().toLowerCase();
    if (!String(cardData.website || '').trim() && firstType !== 'navigate') {
        throw new Error('卡片缺少入口地址：请填写顶层 website，或把第一步设为 navigate（含 url）。');
    }
}

// ── 工具目录（上报给服务器，AI 据此调用）────────────────────────────────────
// 卡片相关能力统一为唯一入口 manage_card（管理 + 执行合一）；旧工具名
// get_status / run_card / write_card 仍在执行侧兼容（服务器可能缓存旧 toolDefs）。
// 服务器存储这些 schema 并在 mcp.list_tools / describe_tool 中呈现。
function effectiveAgentToolDefs() {
    return [
        {
            name: 'manage_card',
            description: '自动化卡片唯一入口（管理 + 执行合一）。action=rules 返回卡片步骤类型（9 种 type 及其字段、默认超时）与运行规则（失败重试、变量输入、需显式 save_cookies 步骤保存 Cookie 等）——写卡片前必须先调用，字段与步骤类型只能取自规范，不要凭空编造；action=list 列出所有已保存卡片的基本信息（id、名称、步骤数、保存时间、是否选中）；action=get 读取指定卡片完整 JSON；action=write 创建新卡片或用同一个 id 覆盖已有卡片（需 cardData，至少含 name/website/steps，写入前会按规范校验并拒绝非法步骤类型）；action=delete 删除卡片；action=run 在当前活动标签页执行卡片，可用 inputs 按变量键覆盖各 type 步骤的输入文本（默认用步骤 text），执行中通过 task:progress 及时反馈完整过程（每步开始/完成/重试/错误），最终返回结果（可能耗时数分钟；同一时间只能有一个 run；等待步骤失败最多重试 3 次，其他动作失败后不重试）。无论成功或失败，结果都含 execution 字段——完整执行明细：startedAt/finishedAt/durationMs 总耗时、stepsTotal/stepsExecuted/succeeded/failed/skipped/retries 统计，以及 steps[]（每步 stepIndex/stepName/status/attempts/durationMs 与 attemptDetails 逐次尝试的耗时和错误），可据此复盘每一步实际发生了什么、卡在哪一步、耗时多久。run 失败时另返回结构化现场：errorCode、失败步骤 stepIndex/stepName/selector、failureSnapshot（当前页 URL/标题 + 近似候选元素）与 context（已用到的变量值）；页面停留在失败现场——修复卡片（write）后用 action=run + start_step=stepIndex 并通过 inputs 回传已用到的变量值即可从失败步骤继续，不必从头执行。',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['rules', 'list', 'get', 'write', 'delete', 'run'], description: 'rules 获取步骤类型与运行规则（写卡片前必看）；list 列出全部卡片；get 读取卡片完整 JSON；write 写入/覆盖卡片；delete 删除卡片；run 执行卡片。' },
                    id: { type: 'string', description: '目标卡片 id：get/run 省略时用当前选中卡片；write 省略时按卡片名新建（同名覆盖）；delete 必填；rules/list 忽略。' },
                    cardData: { type: 'object', description: '完整卡片 JSON（至少含 name/website/steps），仅 action=write 需要；格式必须严格遵循 action=rules 返回的规范。' },
                    inputs: { type: 'object', description: '可选：action=run 时按「变量键→值」覆盖对应 type 步骤的输入文本。每个 type 步骤都是一个变量，键取步骤 variable 字段，未设置则按其在全部 type 步骤中的顺序回退为 var1/var2/...；未提供覆盖值时用步骤自身 text 作为默认。也可传数组按序映射 var1..varN。若某变量键为 account/password/email，会同时用于 Cookie 命名与结果。' },
                    account: { type: 'string', description: '可选：兼容别名，等价于 inputs.account（用于名为 account 的变量与 Cookie 命名）。' },
                    password: { type: 'string', description: '可选：兼容别名，等价于 inputs.password（用于名为 password 的变量与 Cookie 命名）。' },
                    email: { type: 'string', description: '可选：兼容别名，等价于 inputs.email（用于名为 email 的变量）。' },
                    start_step: { type: 'number', description: '可选：action=run 时从第 N 步开始执行（1-based，序号与失败结果 stepIndex 一致；卡片 website 自动插入的 navigate 前置步骤算第 1 步）。用于失败修复后续跑：页面停留在失败现场，跳过已成功的步骤直接继续；同时通过 inputs 回传已用到的变量值。' },
                    timeout_seconds: { type: 'number', description: '可选：action=run 的结果等待上限（秒），默认 900。步骤多、等待久的超长卡片可上调（上限 1800）；调用方据此等待，避免长任务被过早判定超时而拿不到完整 execution 明细。' }
                },
                required: ['action']
            }
        },
        {
            name: 'save_cookies',
            description: '抓取当前活动标签页的 Cookie、localStorage、sessionStorage，默认保存为本地 JSON 文件；若提供 server_url 会额外把数据 POST 到该地址。若 save_to_server=true（推荐给 AI 使用），则将完整数据返回服务器，服务器会自动保存到该 AI 对应的工作目录（cookies/ 子文件夹）中，返回的 result 只保留元数据与保存路径，不含原始 Cookie 内容。',
            input_schema: {
                type: 'object',
                properties: {
                    account: { type: 'string', description: '可选：关联账号，用于文件命名。' },
                    password: { type: 'string', description: '可选：关联密码，用于文件命名。' },
                    server_url: { type: 'string', description: '可选：抓取结果额外 POST 上传的服务器地址。' },
                    card_key: { type: 'string', description: '可选：随上传附带的卡密/凭证标识。' },
                    save_to_server: { type: 'boolean', description: 'AI 调用时设为 true：将抓取的完整 Cookie 数据随任务结果返回服务器，由服务器持久化保存到对应 AI 的目录（cookies/ 下）。不回传原始内容到聊天记录。' }
                }
            }
        },
        // ── 导航与搜索 ─────────────────────────────────────────────────────
        {
            name: 'browser_tab',
            description: '浏览器标签页与导航管理：列出已打开页面、切换标签、在当前页覆盖跳转、新标签打开链接、关闭标签、前进后退。动作仅 7 种：list 获取全部页面及当前激活页；switch 切换到已有 tab_id；replace 在当前页（或 tab_id）覆盖跳转到 url；navigate 在新标签页打开 url；close 关闭标签；back/forward 历史导航。流程：先 list，目标页已开则 switch，要在当前页改地址用 replace，并行任务用 navigate。navigate/replace 成功回执附 cardStep（navigate 步骤对象），可直接拼进自动化卡片 steps。',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'switch', 'replace', 'navigate', 'close', 'back', 'forward'], description: 'list 列出全部标签并返回 activeTab；switch 切换到 tab_id（不改 URL）；replace 在当前/指定标签覆盖跳转到 url；navigate 在新标签打开 url；close 关闭 tab_id（默认当前标签）；back/forward 后退/前进一步。' },
                    url: { type: 'string', description: 'action=replace / navigate 时要打开的 URL（缺协议时按 https 补全）。' },
                    tab_id: { type: 'number', description: 'action=switch 必填；action=close/replace/back/forward 可选，指定目标标签，默认当前活动标签。' },
                    tabId: { type: 'number', description: 'tab_id 的兼容别名。' },
                    id: { type: 'number', description: 'tab_id 的兼容别名。' }
                },
                required: ['action']
            }
        },
        // ── 页面观察 ───────────────────────────────────────────────────────
        {
            name: 'browser_observe',
            description: '感知当前视口里用户能看到的内容：返回 items 单一混排列表（按位置排序、已去重），kind=interactive 是最顶层、未被遮挡的按钮/链接/输入框/下拉/菜单项等（每项带临时 id + tag/selector/name/placeholder/ariaLabel/value/optionsSample 等基本信息），kind=text 是普通可见文本，kind=media 是图片/视频/音频（category=image/video/audio，不可点击），kind=frame 是页面内 iframe 边界（accessible=true 表示同源已扫描，其子元素以 inFrame=true 的 interactive 返回）。会扫描主文档、同源（含嵌套）iframe 内部内容以及 Shadow DOM（开放与被强制开放的封闭 root），并识别 img/video/audio 媒体元素；跨域 iframe 内部仍不可访问。除固定的按钮/链接/表单控件外，还会识别 cursor:pointer 或类名/ID 以 btn/button/link 结尾的自定义控件。若匹配条目超过 limit/max_items，默认不返回 items，只返回 tooMany=true 与 categoryCounts，提示继续用 filter/tag/keyword 缩小范围；也可传 frame（iframe 的 frameSelector）或 frame_path 只观察某个 iframe 内部。默认会在页面上绘制描边标记：绿色=可点击、红色=被遮挡/禁用/不可点、紫色虚线=iframe 边界。用途：点击/输入前的首选观察手段 + 卡片信息收集。场景：observe 后优先使用返回的 selector 或 text+tag 构造自动化卡片步骤（持久化推荐）；ref 可用于临时 browser_action 操作；页面变化后重新 observe（id 只在下一次 observe 前有效）。',
            input_schema: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: '最多返回的可交互元素条目数；超过时默认不返回 items，只返回 tooMany/categoryCounts。默认 120，最大 200。' },
                    max_items: { type: 'number', description: '最终 items 混排列表允许返回的最大总条数；超过时默认不返回 items，只返回 categoryCounts。默认约等于 limit + text_limit + 40，最大 500。' },
                    filter: {
                        type: ['string', 'array'],
                        items: { type: 'string' },
                        description: '按类别筛选，缩小噪音。可传单个字符串、逗号分隔字符串或字符串数组。可选类别：button（按钮）、link（链接）、input（输入框/文本域/可编辑区）、select（下拉框）、checkbox（复选/开关）、radio（单选）、tab（标签页）、menuitem（菜单项）、option（选项）、label（标签元素）、image/video/audio 或 media（媒体）、text（普通可见文本）、frame（iframe 边界）。例：filter:"button" 只看按钮；filter:["input","select"] 只看输入框和下拉框；不传或传 "all" 则返回全部。'
                    },
                    frame: { type: 'string', description: '只观察某个同源 iframe 内部：传 browser_observe 返回的该 frame 的 frameSelector。用于整页 items 过多时钻取单个 iframe（如内嵌编辑器）。' },
                    frame_path: { type: 'array', items: { type: 'string' }, description: 'frame 的多级形式：从外到内的 iframe frameSelector 数组，用于嵌套 iframe 定位。' },
                    tag: { type: ['string', 'array'], items: { type: 'string' }, description: '按 HTML 标签名进一步筛选，如 "button"、"a"、"input"，也可传数组或逗号分隔字符串。' },
                    tags: { type: ['string', 'array'], items: { type: 'string' }, description: 'tag 的别名。' },
                    keyword: { type: 'string', description: '按关键词筛选，匹配可见文本、aria-label/title、name/id、href 等常用字段；也兼容 query/text_filter。' },
                    query: { type: 'string', description: 'keyword 的兼容别名。' },
                    text_filter: { type: 'string', description: 'keyword 的兼容别名。' },
                    include_text: { type: 'boolean', description: '是否同时包含普通可见文本（items 中 kind=text 的条目）。默认 true；传 false 时只返回可交互元素。' },
                    text_limit: { type: 'number', description: '最多返回的普通可见文本条数。默认 200，最大 500。' },
                    allow_truncate: { type: 'boolean', description: '为 true 时即使超过 limit/max_items 也截断返回；默认 false，即超量时不返回 items，只给 categoryCounts 和筛选提示。' },
                    mark: { type: 'boolean', description: '是否在页面上绘制状态色描边标记，便于随后截图查看。默认 true；传 false 只清除已有标记、不重绘。标记为纯视觉叠加，不影响其他工具或点击。' }
                }
            }
        },
        // ── 页面交互 ───────────────────────────────────────────────────────
        {
            name: 'browser_action',
            description: '页面交互聚合工具：用 action 指定要做的动作——点击 click（单击）、双击 double_click、右键 right_click、滚动 scroll、输入文本 type、键盘按键 press_key。定位优先级：selector（observe 返回的稳定 CSS）或 text > ref（临时 id，仅本次有效） > 坐标；非坐标点击会先做遮挡检测，被遮挡时返回 occluded 诊断（需穿透点击传 force:true）。\n' +
                '· click / double_click / right_click：派发 pointer+mouse 合成事件序列（非 CDP trusted 事件，多数站点的框架事件监听能覆盖，但个别依赖真实用户手势的场景可能无效）。\n' +
                '· scroll：滚动页面，返回滚动前后位置与移动像素数。\n' +
                '· type：向 input/textarea/可编辑区输入文本（单字段；多字段请多次 type）；submit:true 时优先调用所在表单的 requestSubmit()（合成键盘事件不会触发浏览器原生 Enter 提交，这里用等效方式兜底）。\n' +
                '· press_key：在焦点元素或指定 selector 上派发合成键盘事件，可带 Ctrl/Shift/Alt/Meta 修饰键；同样不是 CDP trusted 事件，按 Enter 时会尝试兜底 requestSubmit()。\n' +
                '用途：统一的点击/滚动/输入/键盘入口。场景：先 browser_observe 获取元素基本信息（含 selector），用 selector/text 构造卡片步骤或用 ref 做临时 browser_action；页面变化后自行再 observe。\n' +
                '· cardStep 回执：click（单击）/type 成功后返回 cardStep 字段——与自动化卡片规范同构的步骤对象（name/type/selector[/text]，selector 为稳定 CSS）。探索验证通过后直接把各步 cardStep 按顺序拼进 manage_card write 的 steps 即可固化为卡片；text 值按需替换为 {account}/{password}/{email}/{code} 模板。cardStep.inFrame=true 表示元素在 iframe 内（卡片 runner 只查主文档，勿直接写入，见 cardStepNote）。',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'scroll', 'type', 'press_key'], description: '要执行的交互动作。' },
                    ref: { type: ['number', 'string'], description: 'browser_observe 返回的元素临时 id（click/double_click/right_click/type 均可用）；仅本次 observe 有效。优先推荐使用 observe 返回的 selector 或 text（现包含 tag/name/placeholder 等基本信息），适合构造持久化自动化卡片步骤。' },
                    selector: { type: 'string', description: '目标元素的 CSS selector（click/double_click/right_click 定位；type 指定输入框；press_key 指定先聚焦的元素；scroll 可指定滚动进视口的元素）。' },
                    text: { type: 'string', description: 'action=click/double_click/right_click 时用可见文本定位元素；action=type 时为「要输入的文本」。' },
                    x: { type: 'number', description: 'click/double_click/right_click 的 X 坐标（像素，视口坐标）。' },
                    y: { type: 'number', description: 'click/double_click/right_click 的 Y 坐标（像素，视口坐标）。' },
                    force: { type: 'boolean', description: 'action=click 时为 true 即使被遮挡也强制点击；默认 false：被遮挡返回 occluded 诊断。' },
                    direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'action=scroll 的方向：up 上、down 下、top 到顶、bottom 到底。' },
                    amount: { type: 'number', description: 'action=scroll 的滚动像素数。默认 400。' },
                    clear_first: { type: 'boolean', description: 'action=type 时输入前先清空字段。默认 true。' },
                    submit: { type: 'boolean', description: 'action=type 时输入后尝试提交所在表单。' },
                    key: { type: 'string', description: 'action=press_key 的键名，如 "Enter"、"Escape"、"Tab"、"ArrowDown"、"a"。' },
                    ctrl: { type: 'boolean', description: 'action=press_key 时按住 Ctrl。' },
                    shift: { type: 'boolean', description: 'action=press_key 时按住 Shift。' },
                    alt: { type: 'boolean', description: 'action=press_key 时按住 Alt。' },
                    meta: { type: 'boolean', description: 'action=press_key 时按住 Meta/Cmd。' }
                },
                required: ['action']
            }
        },
        {
            name: 'browser_wait',
            description: '等待某个 CSS selector 出现，或固定等待一段时间。用途：等待页面/元素就绪后再操作。场景：等异步加载的按钮出现、等动画结束、给页面留出渲染时间。selector 命中成功时回执附 cardStep（wait 步骤对象），可直接拼进自动化卡片 steps。',
            input_schema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: '等待出现的 CSS 元素。' },
                    ms: { type: 'number', description: '固定等待的毫秒数（不传 selector 时使用；默认 1000）。' }
                }
            }
        },
    ];
}

// ── 状态广播（推送给已打开的 popup）──────────────────────────────────────────
function agentStatePayload() {
    return {
        status: agentStatus,
        boundAiConfigId: agentBoundAiConfigId,
        authRejected: agentAuthRejected,
        lastErrorReason: agentLastErrorReason || ''
    };
}

function broadcastAgentStatus() {
    // popup 可能未打开；忽略「无接收方」错误。
    try {
        chrome.runtime.sendMessage({ type: 'agent:status', ...agentStatePayload() }).catch(() => {});
    } catch (_error) {}
}

function setAgentStatus(status, reason) {
    agentStatus = status;
    if (reason != null) {
        agentLastErrorReason = String(reason);
    } else if (status !== 'error') {
        agentLastErrorReason = '';
    }
    if (status !== 'enrolled' && status !== 'connected') {
        agentBoundAiConfigId = null;
    }
    const badgeColors = {
        disconnected: '#787878',
        connecting: '#f59e0b',
        connected: '#6366f1',
        enrolled: '#22c55e',
        error: '#ef4444'
    };
    try {
        chrome.action.setBadgeBackgroundColor({ color: badgeColors[status] || '#787878' });
        chrome.action.setBadgeText({ text: status === 'enrolled' ? '●' : status === 'error' ? '!' : '' });
        chrome.action.setTitle({ title: `AI自动化插件 — ${status}${reason ? `（${reason}）` : ''}` });
    } catch (_error) {}
    broadcastAgentStatus();
}

// ── 机器码 ──────────────────────────────────────────────────────────────────
async function getAgentMachineId() {
    if (agentMachineId) {
        return agentMachineId;
    }
    const stored = await chrome.storage.local.get('_agent_mid');
    if (stored && stored._agent_mid) {
        agentMachineId = stored._agent_mid;
        return agentMachineId;
    }
    const id = `ba-${Math.random().toString(36).slice(2, 10)}`;
    await chrome.storage.local.set({ _agent_mid: id });
    agentMachineId = id;
    return id;
}

function parseAiConfigId(raw) {
    const n = typeof raw === 'number' ? raw : (raw != null && String(raw).trim() !== '' ? Number(raw) : null);
    return Number.isFinite(n) ? n : null;
}

// ── 设备登记 ────────────────────────────────────────────────────────────────────
async function emitAgentEnrollOn(socket) {
    const settings = await getAgentSettings();
    const auth = await getAgentAuth();
    if (settings.offlineMode) {
        return;
    }
    const id = settings.deviceId || await getAgentMachineId();
    agentCurrentId = id;
    const toolDefs = effectiveAgentToolDefs();
    socket.emit(DEVICE_ENROLL, {
        id,
        // 与扩展端一致：设备不自选 AI，登录连接后由网页端「作坊」为其分配；服务器
        // 每次登记都会重新套用该绑定，因此这里始终发送 aiConfigId: null。
        aiConfigId: null,
        name: settings.agentName || 'AI自动化浏览器',
        group: settings.agentGroup || '',
        platform: `browser-extension (${(typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent.split(' ').pop() : 'chrome')})`,
        os: { platform: 'browser', arch: 'unknown', release: AGENT_VERSION, hostname: id },
        capabilities: toolDefs.map((t) => t.name),
        toolDefs,
        version: AGENT_VERSION,
        token: auth.token || '',
        userId: auth.userId != null ? auth.userId : null,
        workspaceRoot: '',
        lifecycle: 'registered',
        isWindowsDesktop: false,
        isBrowserExtension: true
    });
}

async function agentEnroll() {
    const settings = await getAgentSettings();
    if (settings.offlineMode || !agentSocket) {
        return;
    }
    await emitAgentEnrollOn(agentSocket);
}

// ── 连接 ────────────────────────────────────────────────────────────────────
async function agentConnect() {
    if (agentSocket && agentSocket.connected) {
        return;
    }
    if (agentConnectPromise) {
        return agentConnectPromise;
    }
    agentConnectPromise = agentDoConnect().finally(() => {
        agentConnectPromise = null;
    });
    return agentConnectPromise;
}

async function agentDoConnect() {
    if (typeof io !== 'function') {
        setAgentStatus('error', 'socket.io 未加载');
        return;
    }
    const settings = await getAgentSettings();
    if (agentSocket && agentSocket.connected) {
        return;
    }
    if (settings.offlineMode) {
        return;
    }

    const auth = await getAgentAuth();
    if (!auth.token) {
        setAgentStatus('disconnected', '未登录');
        return;
    }

    let agentSocketUrl = String(settings.agentSocketUrl || '').trim();
    if (!agentSocketUrl) {
        try {
            agentSocketUrl = await agentGetEndpoint(settings.serverUrl, auth.token);
            await saveAgentSettings({ agentSocketUrl });
        } catch (error) {
            setAgentStatus('error', '无法获取 Agent 连接地址');
            return;
        }
    }

    try {
        agentSocketUrl = new URL(agentSocketUrl).href.replace(/\/$/, '');
    } catch (_error) {
        setAgentStatus('error', 'Agent 连接地址格式无效');
        return;
    }

    if (agentSocket) {
        agentSocket.removeAllListeners();
        agentSocket.disconnect();
        agentSocket = null;
    }

    agentAuthRejected = false;
    setAgentStatus('connecting');

    agentSocket = io(agentSocketUrl, {
        transports: ['websocket', 'polling'],
        reconnectionDelay: 2000,
        reconnectionAttempts: Infinity
    });
    attachAgentListeners(agentSocket);
}

function attachAgentListeners(socket) {
    socket.on('connect', async () => {
        setAgentStatus('connected');
        await agentEnroll();
        flushUnsentAgentOutcomes();
    });

    socket.on('disconnect', (reason) => {
        setAgentStatus('disconnected', reason);
        // 传输层断开 Socket.IO 会自动重连；但服务器显式关闭（io server disconnect，
        // 例如服务端重启）不会自动重连，这里主动补一次。
        if (reason === 'io server disconnect' && !agentAuthRejected) {
            setTimeout(() => {
                if (agentSocket && !agentSocket.connected && !agentSocket.active) {
                    agentSocket.connect();
                }
            }, 2000);
        }
    });

    socket.on('connect_error', (err) => {
        setAgentStatus('error', err && err.message ? err.message : '连接失败');
    });

    socket.on(DEVICE_ENROLLED, (data) => {
        agentBoundAiConfigId = parseAiConfigId(data && data.aiConfigId);
        setAgentStatus('enrolled');
    });

    socket.on('device:list', (rows) => {
        if (!agentCurrentId || !Array.isArray(rows)) {
            return;
        }
        const mine = rows.find((row) => String((row && row.id) || '') === agentCurrentId);
        if (!mine) {
            return;
        }
        const next = parseAiConfigId(mine.aiConfigId != null ? mine.aiConfigId : mine.ai_config_id);
        if (next !== agentBoundAiConfigId) {
            agentBoundAiConfigId = next;
            broadcastAgentStatus();
        }
    });

    socket.on(DEVICE_ENROLL_REJECTED, (data) => {
        const reason = (data && data.reason) || '设备登记被服务器拒绝';
        // 非瞬时错误（token 失效或 AI 归属不符）：用同一 token 重连会无限循环，
        // 因此锁定 authRejected、关闭自动重连并断开，等用户重新登录后再连。
        agentAuthRejected = true;
        try { socket.io.reconnection(false); } catch (_error) {}
        agentDisconnect();
        setAgentStatus('error', reason);
    });

    socket.on('task:dispatch', (task) => { void handleAgentTask(task); });
}

function agentDisconnect() {
    if (agentSocket) {
        agentSocket.disconnect();
        agentSocket = null;
    }
    setAgentStatus('disconnected');
}

// ── 任务结果缓存与回传 ──────────────────────────────────────────────────────
function rememberAgentOutcome(taskId, outcome) {
    agentTaskOutcomes.delete(taskId);
    agentTaskOutcomes.set(taskId, outcome);
    for (const key of agentTaskOutcomes.keys()) {
        if (agentTaskOutcomes.size <= MAX_AGENT_TASK_OUTCOMES) {
            break;
        }
        if (agentTaskOutcomes.get(key) && agentTaskOutcomes.get(key).kind === 'running') {
            continue;
        }
        agentTaskOutcomes.delete(key);
    }
}

function emitAgentOutcome(taskId, outcome) {
    if (!agentSocket || !agentSocket.connected) {
        outcome.unsent = true;
        return;
    }
    if (outcome.kind === 'result') {
        agentSocket.emit('task:result', outcome.payload);
    } else if (outcome.kind === 'error') {
        agentSocket.emit('task:error', { taskId, userId: outcome.userId, error: outcome.error });
    }
    outcome.unsent = false;
}

function flushUnsentAgentOutcomes() {
    if (!agentSocket || !agentSocket.connected) {
        return;
    }
    for (const [taskId, outcome] of agentTaskOutcomes) {
        if (outcome && outcome.unsent) {
            emitAgentOutcome(taskId, outcome);
        }
    }
}

// ── 工具命令执行（task.tool → 自动化卡片 / Cookie 抓取实现）────────────────────
// taskId is threaded only for the long-running 'run' action so that activeMcpCardTask
// can be populated; this enables the card-run-progress listener to forward live
// step progress back as task:progress to the agent/MCP caller.
async function runAgentToolCommand(tool, args, taskId = null) {
    const payload = args && typeof args === 'object' ? args : {};
    switch (tool) {
        case 'manage_card':
        case 'write_card':   // 旧名兼容（服务器可能仍缓存旧 toolDefs）
        case 'get_status':   // 旧名兼容 → action=list
        case 'run_card': {   // 旧名兼容 → action=run
            let action = String(payload.action || '').trim().toLowerCase();
            if (!action) {
                if (tool === 'get_status') {
                    action = 'list';
                } else if (tool === 'run_card') {
                    action = 'run';
                } else if (tool === 'write_card' && payload.cardData) {
                    action = 'write';
                }
            }
            if (action === 'rules' || action === 'get_rules') {
                // stepTypes 冗余给出机器可读列表，便于 AI 直接校验自己生成的步骤。
                return { rules: CARD_FORMAT_RULES, stepTypes: [...CARD_STEP_TYPES], byValues: [...CARD_STEP_BY_VALUES] };
            }
            if (action === 'list' || action === 'status') {
                const state = await loadCardCacheState();
                // 只回基本信息；完整卡片 JSON 用 action=get 获取。
                return {
                    items: state.items.map((item) => ({
                        id: item.id,
                        cardName: item.cardName,
                        stepCount: Array.isArray(item.cardData && item.cardData.steps) ? item.cardData.steps.length : 0,
                        savedAt: item.savedAt,
                        selected: item.id === state.selectedId
                    })),
                    selectedId: state.selectedId
                };
            }
            if (action === 'get') {
                const state = await loadCardCacheState();
                const targetId = String(payload.id || '').trim() || state.selectedId;
                const entry = state.items.find((item) => item.id === targetId);
                if (!entry) {
                    throw new Error(targetId ? `未找到自动化卡片: ${targetId}` : '当前没有已保存的自动化卡片');
                }
                return {
                    id: entry.id,
                    cardName: entry.cardName,
                    savedAt: entry.savedAt,
                    selected: entry.id === state.selectedId,
                    cardData: entry.cardData
                };
            }
            if (action === 'delete') {
                return await deleteCardCacheEntry(String(payload.id || '').trim());
            }
            if (action === 'write' || action === 'create' || action === 'overwrite') {
                validateCardDataForWrite(payload.cardData);
                // id 省略时按卡片名生成，避免落到 saveCardCacheState 的
                // selectedId 兜底而覆盖当前选中的卡片。
                const targetId = String(payload.id || '').trim()
                    || String((payload.cardData && payload.cardData.name) || '').trim()
                    || `automation_${Date.now()}`;
                const state = await loadCardCacheState().catch(() => ({ items: [], selectedId: '' }));
                const overwritten = state.items.some((item) => item.id === targetId);
                const saved = await saveCardCacheState(payload.cardData, targetId);
                return { action: 'write', id: saved.selectedId, overwritten, cardCount: saved.items.length };
            }
            if (action === 'run' || action === 'execute') {
                const state = await loadCardCacheState();
                const targetId = String(payload.id || '').trim();
                const entry = targetId ? state.items.find((item) => item.id === targetId) : null;
                if (targetId && !entry) {
                    throw new Error(`未找到自动化卡片: ${targetId}`);
                }
                activeMcpCardTask = taskId ? { taskId } : null;
                try {
                    if (taskId && agentSocket && agentSocket.connected) {
                        agentSocket.emit('task:progress', { taskId, progress: 3, message: '开始执行自动化卡片（MCP）' });
                    }
                    return await runStandaloneCard({
                        cardData: entry ? entry.cardData : undefined,
                        // 变量输入：inputs 为 { 变量键: 值 } 对象（或数组按序映射 var1..varN），
                        // 覆盖对应 type 步骤的默认输入文本；account/password/email/code 仍作兼容别名。
                        inputs: payload.inputs || payload.variables || {},
                        account: payload.account || '',
                        password: payload.password || '',
                        email: payload.email || '',
                        code: payload.code || '',
                        start_step: Number(payload.start_step || payload.startStep || 0) || 0,
                        isLooping: false
                    });
                } catch (runErr) {
                    // 捕获执行失败，返回带详细原因的结构化结果（而非抛错），让 MCP 返回详细的 error / errorReason
                    let detailedError = (runErr && runErr.message) ? runErr.message : String(runErr || '卡片执行失败');
                    let stepInfo = '';
                    try {
                        const lastProg = await loadStandaloneProgressState().catch(() => null);
                        if (lastProg && typeof lastProg === 'object') {
                            const progErr = String(lastProg.errorReason || lastProg.message || '').trim();
                            if (progErr) {
                                detailedError = progErr;
                            }
                            const sIdx = lastProg.stepIndex != null ? lastProg.stepIndex : '';
                            const sName = String(lastProg.stepName || '').trim();
                            if (sName || sIdx) {
                                stepInfo = `[步骤 ${sIdx}${sName ? ` ${sName}` : ''}] `;
                            }
                            if (lastProg.cardName && !detailedError.includes(lastProg.cardName)) {
                                // 确保卡片名可见
                            }
                        }
                    } catch (_) {}
                    const finalErr = stepInfo + detailedError;
                    // 尽量从最后进度状态带出更多上下文
                    let extra = {};
                    try {
                        const lp = await loadStandaloneProgressState().catch(() => null);
                        if (lp) {
                            extra = {
                                stepIndex: lp.stepIndex,
                                stepTotal: lp.stepTotal,
                                stepName: lp.stepName,
                                phase: lp.phase
                            };
                        }
                    } catch (_) {}
                    // 06_automation_run.js 在最终失败时把结构化详情挂在 error.failure 上：
                    // errorCode / 失败步骤 / selector / 现场快照（URL+候选元素）/ 运行上下文。
                    // 合并进结果并给出续跑提示，形成「失败 → 修卡 → start_step 续跑」闭环。
                    const failure = (runErr && typeof runErr === 'object' && runErr.failure && typeof runErr.failure === 'object')
                        ? runErr.failure
                        : null;
                    return {
                        success: false,
                        cardName: (entry && entry.cardName) || '',
                        error: finalErr,
                        errorReason: finalErr,
                        account: payload.account || '',
                        password: payload.password || '',
                        email: payload.email || '',
                        cookiesSaved: false,
                        stopped: false,
                        ...extra,
                        // 完整执行明细（每步过程 / 尝试次数 / 每步耗时），失败也一并带回
                        ...(runErr && runErr.execution ? { execution: runErr.execution } : {}),
                        ...(failure ? {
                            errorCode: failure.errorCode || '',
                            stepIndex: failure.stepIndex,
                            stepTotal: failure.stepTotal,
                            stepName: failure.stepName,
                            stepType: failure.stepType,
                            selector: failure.selector,
                            attempts: failure.attempts,
                            failureSnapshot: failure.failureSnapshot || null,
                            context: failure.context || null,
                            resumeHint: `页面已停在失败现场。修复卡片（action=write）后可用 action=run + start_step=${failure.stepIndex} 从失败步骤继续，并把本结果 context 里已用到的变量值（如 account/password/email/code 或自定义变量键）通过 inputs 原样回传，避免丢失验证码等运行期取值。`
                        } : {})
                    };
                } finally {
                    activeMcpCardTask = null;
                }
            }
            throw new Error(`未知的 manage_card action: ${action || '(空)'}（可选 rules/list/get/write/delete/run）`);
        }
        case 'save_cookies':
        case 'capture_cookies': {
            const saveToServer = !!(payload.saveToServer || payload.save_to_server);
            const raw = await captureCurrentTab({
                account: payload.account || '',
                password: payload.password || '',
                serverUrl: payload.serverUrl || payload.server_url || '',
                cardKey: payload.cardKey || payload.card_key || '',
                saveToServer
            });
            // 仅当 save_to_server 请求时才把原始数据带回（供服务器落盘到 AI 目录）；默认不带，避免泄漏。
            const out = {
                success: raw && raw.success !== false,
                fileName: raw && raw.fileName,
                cookieCount: raw && raw.cookieCount,
                browserStorageCount: raw && raw.browserStorageCount,
                pageUrl: raw && raw.pageUrl,
                upload: raw && raw.upload
            };
            if (saveToServer && raw) {
                if (raw.cookies) out.cookies = raw.cookies;
                if (raw.browserStorage) out.browserStorage = raw.browserStorage;
                if (raw.data) out.data = raw.data;
                out.save_to_server = true;
            }
            return out;
        }
        case 'browser_tab':
            return await toolBrowserTab(payload);
        case 'browser_observe':
            return await toolBrowserObserve(payload);
        case 'browser_action':
            return await toolBrowserAction(payload);
        case 'browser_wait':
            return await toolBrowserWait(payload);
        default:
            throw new Error(`未知工具: ${tool || '(空)'}`);
    }
}

function summarizeAgentResult(tool, result) {
    if (result && typeof result === 'object') {
        if (typeof result.summary === 'string' && result.summary.trim()) {
            return result.summary.trim();
        }
        if (tool === 'save_cookies') {
            const cnt = Number(result.cookieCount || 0);
            if (result.saved_to_server && result.file_name) {
                return `已抓取 Cookie ${cnt} 条，已保存到服务器 AI 目录: ${result.file_name}`;
            }
            return `已抓取 Cookie ${cnt} 条`;
        }
        if (tool === 'manage_card' || tool === 'write_card' || tool === 'get_status' || tool === 'run_card') {
            if (result.rules) {
                return '已返回自动化卡片步骤类型与运行规则';
            }
            if (Array.isArray(result.items)) {
                return `共 ${result.items.length} 张自动化卡片`;
            }
            if (result.deleted) {
                return `已删除自动化卡片: ${result.id}`;
            }
            if (result.cardData) {
                return `已获取自动化卡片: ${result.cardName || result.id}`;
            }
            if (result.action === 'write') {
                return `${result.overwritten ? '已覆盖' : '已创建'}自动化卡片: ${result.id}（现共 ${result.cardCount} 张）`;
            }
            if (result.cardName) {
                const exec = result.execution && typeof result.execution === 'object' ? result.execution : null;
                let execTag = '';
                if (exec) {
                    const secs = (Number(exec.durationMs || 0) / 1000).toFixed(1);
                    execTag = `（${Number(exec.stepsExecuted || 0)}/${Number(exec.stepsTotal || 0)} 步，耗时 ${secs}s`
                        + (Number(exec.retries || 0) > 0 ? `，重试 ${exec.retries} 次` : '')
                        + (Number(exec.skipped || 0) > 0 ? `，跳过 ${exec.skipped} 步` : '')
                        + '）';
                }
                if (result.success === false) {
                    const reason = String(result.error || result.errorReason || result.message || '未知原因').trim();
                    const codeTag = String(result.errorCode || '').trim();
                    return `执行失败: ${result.cardName} - ${codeTag ? `[${codeTag}] ` : ''}${reason}${execTag}`;
                }
                return `执行完成: ${result.cardName}${execTag}`;
            }
        }
        if (tool === 'browser_tab') {
            return `browser_tab ${result.action || ''} 完成${result.url ? `: ${result.url}` : ''}`;
        }
        if (tool === 'browser_observe') {
            return result.tooMany
                ? `匹配元素过多（${result.itemCount || 0} 个），已收窄筛选提示`
                : `共 ${Number(result.count || 0)} 个可交互元素、${Number(result.textCount || 0)} 段文本`;
        }
        if (tool === 'browser_action') {
            return result.success === false
                ? `${result.code || 'browser_action'} 未成功: ${result.error || ''}`
                : `browser_action 完成`;
        }
        if (tool === 'browser_wait') {
            return result.success === false ? `等待超时: ${result.error || ''}` : '等待完成';
        }
    }
    return `${tool} 执行完成`;
}

async function handleAgentTask(task) {
    const taskId = task && task.taskId;
    if (!taskId) {
        return;
    }

    const cached = agentTaskOutcomes.get(taskId);
    if (cached) {
        if (cached.kind === 'result' || cached.kind === 'error') {
            emitAgentOutcome(taskId, cached);
        }
        return;
    }

    agentTaskOutcomes.set(taskId, { kind: 'running' });
    const tool = task.tool || '';
    if (agentSocket && agentSocket.connected) {
        agentSocket.emit('task:progress', { taskId, progress: 0, message: `执行 ${tool}...` });
    }

    try {
        const result = await runAgentToolCommand(tool, task.args || {}, taskId);
        const success = !(result && result.success === false);
        const payload = {
            taskId,
            userId: task.userId,
            aiConfigId: task.aiConfigId,
            sessionId: task.sessionId,
            tool,
            success,
            result,
            summary: summarizeAgentResult(tool, result)
        };
        const entry = { kind: 'result', payload };
        rememberAgentOutcome(taskId, entry);
        emitAgentOutcome(taskId, entry);
    } catch (error) {
        const errMsg = error && error.message ? error.message : String(error);
        // 尽量保留更多上下文（例如卡片相关）
        const detailedErr = (task && task.args && task.args.id) ? `${errMsg} (卡片ID: ${task.args.id})` : errMsg;
        const entry = { kind: 'error', error: detailedErr, userId: task.userId };
        rememberAgentOutcome(taskId, entry);
        emitAgentOutcome(taskId, entry);
    }
}

// ── 生命周期 / 保活 ─────────────────────────────────────────────────────────
async function restoreAndConnectAgent() {
    const settings = await getAgentSettings();
    const auth = await getAgentAuth();
    if (!settings.offlineMode && auth.token && !agentAuthRejected) {
        await agentConnect();
    }
}

function nudgeAgentSocket() {
    if (agentAuthRejected) {
        return;
    }
    if (!agentSocket) {
        void restoreAndConnectAgent();
        return;
    }
    if (!agentSocket.connected && !agentSocket.active) {
        agentSocket.connect();
    }
}

try {
    chrome.alarms.create(AGENT_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
} catch (_error) {}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === AGENT_KEEPALIVE_ALARM) {
        nudgeAgentSocket();
    }
});

chrome.runtime.onStartup.addListener(() => {
    void restoreAndConnectAgent();
});

// 登录/登出通常经 popup → background 消息触发，这里再兜底监听 auth 存储变化，
// 保证令牌变化时始终尝试连接/断开。
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[AGENT_AUTH_KEY]) {
        return;
    }
    const oldToken = String((changes[AGENT_AUTH_KEY].oldValue && changes[AGENT_AUTH_KEY].oldValue.token) || '');
    const newToken = String((changes[AGENT_AUTH_KEY].newValue && changes[AGENT_AUTH_KEY].newValue.token) || '');
    if (oldToken === newToken) {
        return;
    }
    agentAuthRejected = false;
    if (newToken) {
        if (agentSocket) {
            agentDisconnect();
        }
        void agentConnect();
    } else {
        agentDisconnect();
    }
});

// ── popup 消息接口 ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string' || !message.type.startsWith('agent:')) {
        return false;
    }

    (async () => {
        try {
            switch (message.type) {
                case 'agent:get-state': {
                    const settings = await getAgentSettings();
                    const auth = await getAgentAuth();
                    // avatar 是服务器相对路径，转成 data URL 后 popup 才能显示。
                    const avatarDataUrl = auth.token
                        ? await resolveAgentAvatarDataUrl(settings.serverUrl, auth.avatar, auth.token)
                        : '';
                    sendResponse({
                        ok: true,
                        ...agentStatePayload(),
                        settings,
                        auth: {
                            loggedIn: !!auth.token,
                            account: auth.account || '',
                            userName: auth.userName || '',
                            userId: auth.userId,
                            avatar: avatarDataUrl,
                            rememberLogin: auth.rememberLogin === true
                        }
                    });
                    break;
                }
                case 'agent:save-settings': {
                    const prev = await getAgentSettings();
                    const payload = { ...(message.payload || {}) };
                    const serverChanged = payload.serverUrl !== undefined && payload.serverUrl !== prev.serverUrl;
                    // 换服务器后旧的 agentSocketUrl 失效，清掉让其重新解析。
                    if (serverChanged && payload.agentSocketUrl === undefined) {
                        payload.agentSocketUrl = '';
                    }
                    const next = await saveAgentSettings(payload);
                    if (payload.offlineMode === true && agentSocket && agentSocket.connected) {
                        agentDisconnect();
                    } else if ((serverChanged || payload.agentSocketUrl !== undefined) && agentSocket) {
                        agentDisconnect();
                        if (!next.offlineMode) {
                            void agentConnect();
                        }
                    }
                    sendResponse({ ok: true, settings: next });
                    break;
                }
                case 'agent:login': {
                    const settings = await getAgentSettings();
                    const account = String((message.payload && message.payload.account) || '').trim();
                    const password = String((message.payload && message.payload.password) || '');
                    const remember = (message.payload && message.payload.rememberLogin) === true;
                    if (!account || !password) {
                        sendResponse({ ok: false, error: '请填写账号和密码' });
                        break;
                    }
                    const result = await agentLogin(settings.serverUrl, account, password);
                    agentAuthRejected = false;
                    await saveAgentAuth({
                        token: result.token,
                        account,
                        password: remember ? password : '',
                        rememberLogin: remember,
                        userId: result.user && result.user.id != null ? result.user.id : null,
                        userName: (result.user && (result.user.name || result.user.account)) || account,
                        avatar: (result.user && result.user.avatar) || ''
                    });
                    await saveAgentSettings({ agentSocketUrl: result.agentSocketUrl });
                    void agentConnect();
                    sendResponse({
                        ok: true,
                        auth: {
                            loggedIn: true,
                            account,
                            userName: (result.user && (result.user.name || result.user.account)) || account
                        }
                    });
                    break;
                }
                case 'agent:logout': {
                    agentAuthRejected = false;
                    agentDisconnect();
                    await clearAgentAuth();
                    await saveAgentSettings({ agentSocketUrl: '' });
                    await chrome.storage.local.remove(AGENT_AVATAR_CACHE_KEY).catch(() => {});
                    sendResponse({ ok: true });
                    break;
                }
                case 'agent:connect': {
                    agentAuthRejected = false;
                    if (agentSocket && agentSocket.connected) {
                        await emitAgentEnrollOn(agentSocket);
                    } else {
                        await agentConnect();
                    }
                    sendResponse({ ok: true, ...agentStatePayload() });
                    break;
                }
                case 'agent:disconnect': {
                    agentDisconnect();
                    sendResponse({ ok: true, ...agentStatePayload() });
                    break;
                }
                case 'agent:test-connection': {
                    const settings = await getAgentSettings();
                    const auth = await getAgentAuth();
                    let http = { ok: false };
                    try {
                        const base = trimUrl(settings.serverUrl);
                        const start = Date.now();
                        const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
                        http = { ok: true, status: res.status, ms: Date.now() - start };
                    } catch (error) {
                        http = { ok: false, error: error && error.message ? error.message : String(error) };
                    }
                    sendResponse({ ok: http.ok, http, needsLogin: !auth.token });
                    break;
                }
                default:
                    sendResponse({ ok: false, error: `未知指令: ${message.type}` });
            }
        } catch (error) {
            sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
        }
    })();

    return true; // async sendResponse
});

// ── MCP 卡片执行进度转发（使 manage_card run 能及时反馈完整过程，而非仅最终结果）────
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (!message || message.type !== 'card-run-progress' || !activeMcpCardTask || !agentSocket || !agentSocket.connected) {
        return false;
    }
    try {
        const p = message;
        const progNum = Number.isFinite(Number(p.progress)) ? Math.max(0, Math.min(100, Number(p.progress))) : 0;
        const progressPayload = {
            taskId: activeMcpCardTask.taskId,
            progress: progNum,
            message: p.message || `卡片执行进度 ${progNum}%`,
            phase: p.phase || '',
            stepIndex: p.stepIndex,
            stepTotal: p.stepTotal,
            stepName: p.stepName,
            kind: p.kind || '',
            retrying: !!p.retrying,
            cardName: p.cardName || '',
            mode: p.mode,
            errorReason: p.errorReason || p.error || '',
            errorCode: p.errorCode || '',
            previousStepName: p.previousStepName || '',
            nextStepName: p.nextStepName || ''
        };
        agentSocket.emit('task:progress', progressPayload);
    } catch (_e) {}
    return false;
});

// 模块加载即尝试恢复连接（SW 被唤醒时）。
void restoreAndConnectAgent();
