'use strict';

const objectSchema = (properties, required = []) => ({
  type: 'object', properties, ...(required.length ? { required } : {}),
});

const NATIVE_BROWSER_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'manage_card',
    description: '管理并运行原生 Chromium 自动化卡片。支持 rules/list/get/write/patch_step/insert_step/delete_step/move_step/delete/run。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['rules', 'list', 'get', 'write', 'patch_step', 'insert_step', 'delete_step', 'move_step', 'delete', 'run'] },
      id: { type: 'string' }, card_name: { type: 'string' }, cardData: { type: 'object' },
      step_index: { type: 'number' }, to_step_index: { type: 'number' }, insert_after: { type: 'number' },
      stepData: { type: 'object' }, stepPatch: { type: 'object' }, replace: { type: 'boolean' },
      inputs: { type: 'object' }, start_step: { type: 'number' }, timeout_seconds: { type: 'number' },
    }, ['action']),
  },
  {
    name: 'browser_file', destructive: true,
    description: '通过 AI 工作区安全下载 URL 或页面中的图片元素、向当前页面上传任意常规文件（图片、视频、音频、文档、压缩包等），或保存当前浏览器会话。上传仍受目标网页 input 的 accept 规则约束；download_element 会按 ref/selector/坐标定位 img，并由当前 Chromium Profile 原生下载 currentSrc。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['download', 'download_element', 'upload', 'save_session', 'info'] },
      url: { type: 'string', description: '下载用绝对 URL 或相对于当前页面的 URL' },
      directory: { type: 'string' }, filename: { type: 'string' }, media_type: { type: 'string' },
      overwrite: { type: 'boolean' }, timeout_ms: { type: 'number' }, max_bytes: { type: 'number' },
      selector: { type: 'string' }, ref: { type: 'string' },
      x: { type: 'number', description: 'download_element 的视口 X 坐标；ref 会自动解析为元素暴露点' },
      y: { type: 'number', description: 'download_element 的视口 Y 坐标；ref 会自动解析为元素暴露点' },
      path: { type: 'string', description: 'AI-Workspace 内任意类型的单个文件路径' },
      paths: { type: 'array', items: { type: 'string' }, description: 'AI-Workspace 内任意类型的多个文件路径' }, mode: { type: 'string' }, page_url: { type: 'string' },
    }, ['action']),
  },
  {
    name: 'browser_tab',
    description: '通过受认证 Chromium Runtime Bridge 管理当前浏览器的导航、页面打开、刷新与焦点。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['list', 'switch', 'replace', 'navigate', 'reload'] },
      url: { type: 'string' }, id: { type: 'string' }, index: { type: 'number' },
    }, ['action']),
  },
  {
    name: 'browser_observe',
    description: '通过 Chromium 隔离世界观察当前页面，并在浏览器原生 UI 层绘制标记。',
    input_schema: objectSchema({
      limit: { type: 'number' }, max_items: { type: 'number' }, filter: { type: 'string' },
      tag: { type: 'string' }, keyword: { type: 'string' }, include_text: { type: 'boolean' },
      include_media: { type: 'boolean' }, text_limit: { type: 'number' },
      mark: { type: 'boolean' }, highlight_duration_ms: { type: 'number' },
    }),
  },
  {
    name: 'browser_screenshot',
    description: '通过 Chromium RenderWidget Surface 截取当前页面 PNG。',
    input_schema: objectSchema({
      selector: { type: 'string' }, full_page: { type: 'boolean' }, x: { type: 'number' }, y: { type: 'number' },
      width: { type: 'number' }, height: { type: 'number' }, send_to_user: { type: 'boolean' },
    }),
  },
  {
    name: 'browser_action', destructive: true,
    description: '通过 Chromium 原生输入执行点击、拖拽选文、整段输入、光标/选区定位、局部插入、滚动或组合按键。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'insert_text', 'set_selection', 'press_key'] },
      selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' },
      x: { type: 'number', description: '视口起点 X；可覆盖 ref 的默认点击中心' },
      y: { type: 'number', description: '视口起点 Y；可覆盖 ref 的默认点击中心' },
      to_x: { type: 'number', description: 'drag 的视口终点 X' },
      to_y: { type: 'number', description: 'drag 的视口终点 Y' },
      start: { type: 'number', description: 'set_selection 的 UTF-16 起始字符位置；start=end 表示光标' },
      end: { type: 'number', description: 'set_selection 的 UTF-16 结束字符位置' },
      selection_direction: { type: 'string', enum: ['forward', 'backward', 'none'] },
      key: { type: 'string', description: '按键名或组合键，例如 Home、Shift+ArrowLeft、Ctrl+A' },
      repeat: { type: 'number', description: 'press_key 重复次数，范围 1-100' },
      ctrl: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' }, meta: { type: 'boolean' },
      direction: { type: 'string' }, amount: { type: 'number' }, timeout_ms: { type: 'number' },
    }, ['action']),
  },
  {
    name: 'browser_wait',
    description: '等待固定时长，或通过 Chromium 原生页面通道等待元素出现。',
    input_schema: objectSchema({
      selector: { type: 'string' }, ref: { type: 'string' }, ms: { type: 'number' }, timeout_ms: { type: 'number' },
    }),
  },
]);

module.exports = { NATIVE_BROWSER_TOOL_DEFINITIONS };
