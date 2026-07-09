// popup/mcp-demos.ts — animated previews for MCP tools with on-page visual effects.

const DEMO_TOOLS = new Set([
  'browser_screenshot',
  'browser_observe',
  'browser_action',
  'browser_drag',
  'browser_wait',
])

const DEMOS: Record<string, { label: string; scene: string }> = {
  browser_screenshot: {
    label: '截图时先高亮取景框并扫描，完成后闪白快门反馈',
    scene: `
      <div class="mcp-demo-scene shot">
        <div class="demo-page"></div>
        <div class="demo-shot-frame"><div class="demo-shot-scan"></div></div>
        <div class="demo-shot-flash"></div>
      </div>`,
  },
  browser_observe: {
    label: '扫描可交互元素并依次标注编号，便于截图对照',
    scene: `
      <div class="mcp-demo-scene observe">
        <div class="demo-page"></div>
        <div class="demo-mark m1"><span>1</span></div>
        <div class="demo-mark m2"><span>2</span></div>
        <div class="demo-mark m3"><span>3</span></div>
      </div>`,
  },
  browser_action: {
    label: '点击/输入/滚动/按键时：光标移动、点击光晕、拖拽轨迹等视觉反馈',
    scene: `
      <div class="mcp-demo-scene click">
        <div class="demo-page"></div>
        <div class="demo-target"></div>
        <div class="demo-cursor"></div>
        <div class="demo-ripple r1"></div>
        <div class="demo-ripple r2"></div>
      </div>`,
  },
  browser_drag: {
    label: '从起点拖到终点，路径上留下渐变拖尾',
    scene: `
      <div class="mcp-demo-scene drag">
        <div class="demo-page"></div>
        <div class="demo-drag-from"></div>
        <div class="demo-drag-to"></div>
        <div class="demo-drag-line"></div>
        <div class="demo-cursor drag-cursor"></div>
      </div>`,
  },
  browser_wait: {
    label: '等待页面加载或元素出现时的呼吸指示',
    scene: `
      <div class="mcp-demo-scene wait">
        <div class="demo-page"></div>
        <div class="demo-wait-ring"></div>
        <div class="demo-wait-dot"></div>
      </div>`,
  },
}

export function hasToolDemo(name: string) {
  return DEMO_TOOLS.has(name)
}

export function renderToolDemo(name: string) {
  const demo = DEMOS[name]
  if (!demo) return ''
  return `
    <div class="card mcp-demo-card">
      <div class="card-title">效果预览</div>
      <div class="mcp-demo-wrap">
        ${demo.scene}
      </div>
      <div class="mcp-demo-caption">${demo.label}</div>
    </div>`
}