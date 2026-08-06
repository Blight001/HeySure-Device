// IPC 契约测试（阶段 2）：contracts/ipc-channels.js 是通道名唯一真源，
// 本测试扫描主进程源码的实际注册，与注册表做双向精确比对。
// 属方案 §4.3 允许的"静态约束"源码扫描：注册表与源码的一致性无法在
// 纯运行时验证（需要枚举全部注册点），故用扫描保证不漂移。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const mainDir = path.join(root, 'src', 'app', 'main');
const contracts = require(path.join(root, 'src', 'app', 'contracts', 'ipc-channels.js'));
const { hasIpcPayloadSchema } = require(path.join(root, 'src', 'app', 'contracts', 'ipc-payloads.js'));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function scanRegistrations() {
  const invoke = new Map(); // channel -> [files]
  const event = new Map();
  for (const file of walk(mainDir)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    // ipcMain.* 为存量直连；ipc.* 为 ipc/registry.js 注册器约定
    const re = /\b(?:ipcMain|ipc)\.(handle|on)\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const map = m[1] === 'handle' ? invoke : event;
      if (!map.has(m[2])) map.set(m[2], []);
      map.get(m[2]).push(rel);
    }
  }
  return { invoke, event };
}

test('同一通道不得在源码中注册多于一次（曾被 monkeypatch 掩盖的真实冲突）', () => {
  const { invoke, event } = scanRegistrations();
  const dupInvoke = [...invoke.entries()].filter(([, files]) => files.length > 1);
  const dupEvent = [...event.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(dupInvoke, [], `invoke 通道重复注册: ${dupInvoke.map(([ch, files]) => `${ch} @ ${files.join(' & ')}`).join('; ')}`);
  assert.deepEqual(dupEvent, [], `event 通道重复注册: ${dupEvent.map(([ch, files]) => `${ch} @ ${files.join(' & ')}`).join('; ')}`);
});

test('主进程实际注册的 invoke/event 通道与 contracts 注册表双向一致', () => {
  const { invoke, event } = scanRegistrations();

  const declaredInvoke = new Set(contracts.INVOKE_CHANNELS.map((c) => c.channel));
  const declaredEvent = new Set(contracts.EVENT_CHANNELS.map((c) => c.channel));

  const undeclaredInvoke = [...invoke.keys()].filter((ch) => !declaredInvoke.has(ch));
  const undeclaredEvent = [...event.keys()].filter((ch) => !declaredEvent.has(ch));
  assert.deepEqual(undeclaredInvoke, [], `源码注册了未登记的 invoke 通道（先在 contracts/ipc-channels.js 登记）: ${undeclaredInvoke.map((ch) => `${ch} @ ${invoke.get(ch)}`).join(', ')}`);
  assert.deepEqual(undeclaredEvent, [], `源码注册了未登记的 event 通道: ${undeclaredEvent.map((ch) => `${ch} @ ${event.get(ch)}`).join(', ')}`);

  const orphanInvoke = [...declaredInvoke].filter((ch) => !invoke.has(ch));
  const orphanEvent = [...declaredEvent].filter((ch) => !event.has(ch));
  assert.deepEqual(orphanInvoke, [], `contracts 登记了源码中不存在的 invoke 通道（删代码须同步删登记）: ${orphanInvoke.join(', ')}`);
  assert.deepEqual(orphanEvent, [], `contracts 登记了源码中不存在的 event 通道: ${orphanEvent.join(', ')}`);
});

test('注册表条目结构完整（channel/kind/domain 必填且 kind 正确）', () => {
  for (const [list, kind] of [
    [contracts.INVOKE_CHANNELS, 'invoke'],
    [contracts.EVENT_CHANNELS, 'event'],
    [contracts.PUSH_CHANNELS, 'push'],
  ]) {
    for (const entry of list) {
      assert.ok(entry.channel && typeof entry.channel === 'string', `空通道名: ${JSON.stringify(entry)}`);
      assert.equal(entry.kind, kind, `${entry.channel} kind 应为 ${kind}`);
      assert.ok(entry.domain, `${entry.channel} 缺少 domain`);
    }
  }
});

test('同一通道不得在 invoke 与 event 中重复登记', () => {
  const invokeNames = new Set(contracts.INVOKE_CHANNELS.map((c) => c.channel));
  const clash = contracts.EVENT_CHANNELS.map((c) => c.channel).filter((ch) => invokeNames.has(ch));
  assert.deepEqual(clash, [], `通道同时登记为 invoke 和 event: ${clash.join(', ')}`);
});

test('通道声明的 requestSchema 必须存在且能由通道名反查', () => {
  const requestChannels = [...contracts.INVOKE_CHANNELS, ...contracts.EVENT_CHANNELS];
  for (const entry of requestChannels) {
    if (!entry.requestSchema) continue;
    assert.equal(
      hasIpcPayloadSchema(entry.requestSchema),
      true,
      `${entry.channel} 引用了未登记 schema: ${entry.requestSchema}`,
    );
    assert.equal(contracts.getRequestSchema(entry.channel), entry.requestSchema);
  }
});

test('首批 schema 通道在注册点实际经过 payload 校验包装', () => {
  const requestChannels = [...contracts.INVOKE_CHANNELS, ...contracts.EVENT_CHANNELS];
  for (const entry of requestChannels) {
    if (!entry.requestSchema) continue;
    const registrar = path.join(root, entry.registrar);
    const source = fs.readFileSync(registrar, 'utf8');
    if (!source.includes(`ipcMain.${entry.kind === 'event' ? 'on' : 'handle'}('${entry.channel}'`)) {
      // ipc/registry.js 对所有 ipc.handle/on 自动包装，模块注册点无需重复包装。
      continue;
    }
    const escaped = entry.channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wrapper = entry.kind === 'event' ? 'wrapLegacyIpcEventPayload' : 'wrapLegacyIpcPayload';
    assert.match(
      source,
      new RegExp(`${wrapper}\\(\\s*['"]${escaped}['"]`),
      `${entry.channel} 声明了 requestSchema 但注册点未应用 ${wrapper}`,
    );
  }
});
