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
    description: '通过 AI 工作区安全下载文件、向当前页面上传本地文件，或保存当前浏览器会话。下载 URL 可为绝对地址或相对于当前页面的地址；当前页面同源的 localhost/私网资源可下载。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['download', 'upload', 'save_session', 'info'] },
      url: { type: 'string', description: '下载用绝对 URL 或相对于当前页面的 URL' },
      directory: { type: 'string' }, filename: { type: 'string' }, media_type: { type: 'string' },
      overwrite: { type: 'boolean' }, timeout_ms: { type: 'number' }, max_bytes: { type: 'number' },
      selector: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } }, mode: { type: 'string' }, page_url: { type: 'string' },
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
      include_media: { type: 'boolean' }, mark: { type: 'boolean' }, highlight_duration_ms: { type: 'number' },
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
    description: '通过 Chromium 原生输入与页面自动化通道点击、输入、滚动或按键。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'scroll', 'type', 'press_key'] },
      selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' },
      key: { type: 'string', description: '按键名或组合键，例如 Enter、Ctrl+Enter' },
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
