'use strict';

async function notifyPluginState(deps, payload, warning) {
  if (typeof deps.onPluginStateChanged !== 'function') return null;
  try {
    return await deps.onPluginStateChanged(payload);
  } catch (error) {
    deps.logger.warn?.(warning, error?.message || error);
    return { ok: false, message: error?.message || String(error) };
  }
}

async function setPluginEnabled(deps, pluginId, enabled) {
  const plugin = deps.getPluginById(pluginId);
  if (!plugin) return { ok: false, message: '插件不存在', state: deps.getPublicState() };
  if (plugin.missing === true && enabled === true) {
    return { ok: false, message: '插件目录不存在，请重新导入', state: deps.getPublicState() };
  }
  plugin.enabled = enabled === true;
  plugin.updatedAt = new Date().toISOString();
  deps.persistState();
  if (plugin.enabled) await deps.loadPluginIntoAllCurrentSessions(plugin);
  else await deps.unloadPluginFromAllSessions(plugin);
  const browserRefresh = await notifyPluginState(deps, {
    plugin: deps.toPublicPlugin(plugin), enabled: plugin.enabled,
  }, '[Extensions] 插件状态已更新，但浏览器刷新失败:');
  deps.syncLegacyTranslateSetting();
  deps.emitStateChanged();
  return { ok: true, plugin: deps.toPublicPlugin(plugin), state: deps.getPublicState(), browserRefresh };
}

function buildImportedPlugin(deps, absPath) {
  deps.readManifest(absPath);
  const existing = deps.getState().plugins.find((plugin) => deps.normalizeAbsolutePath(plugin?.path) === absPath) || null;
  if (existing?.builtin === true) return { error: '该目录是内置插件，无需重复导入' };
  const record = deps.buildPluginRecord(absPath, existing || {}, {
    id: existing?.id || `local-${deps.hashId(absPath)}`,
    builtin: false,
    enabled: true,
    hint: existing?.hint || '自定义导入插件',
  });
  return { existing, record };
}

async function persistImportedPlugin(deps, imported) {
  if (imported.existing?.enabled === true) await deps.unloadPluginFromAllSessions(imported.existing);
  deps.getState().plugins = deps.getState().plugins.filter((plugin) => plugin.id !== imported.record.id);
  deps.getState().plugins.push(imported.record);
  deps.persistState();
  await deps.loadPluginIntoAllCurrentSessions(imported.record);
}

async function importPlugin(deps, sourcePath) {
  const absPath = deps.normalizeAbsolutePath(sourcePath);
  if (!absPath) return { ok: false, message: '未选择插件目录', state: deps.getPublicState() };
  let imported;
  try {
    imported = buildImportedPlugin(deps, absPath);
    if (imported.error) return { ok: false, message: imported.error, state: deps.getPublicState() };
    await persistImportedPlugin(deps, imported);
  } catch (error) {
    return { ok: false, message: error?.message || String(error), state: deps.getPublicState() };
  }
  const plugin = imported.record;
  const browserRefresh = await notifyPluginState(deps, {
    plugin: deps.toPublicPlugin(plugin), enabled: true, imported: true,
  }, '[Extensions] 插件已导入，但浏览器刷新失败:');
  deps.emitStateChanged();
  return { ok: true, plugin: deps.toPublicPlugin(plugin), state: deps.getPublicState(), browserRefresh };
}

async function removePlugin(deps, pluginId) {
  const plugin = deps.getPluginById(pluginId);
  if (!plugin) return { ok: false, message: '插件不存在', state: deps.getPublicState() };
  if (plugin.builtin === true) return { ok: false, message: '内置插件不能删除，可以关闭开关禁用', state: deps.getPublicState() };
  await deps.unloadPluginFromAllSessions(plugin);
  deps.getState().plugins = deps.getState().plugins.filter((item) => item.id !== plugin.id);
  deps.persistState();
  await notifyPluginState(deps, {
    plugin: deps.toPublicPlugin(plugin), enabled: false, removed: true,
  }, '[Extensions] 插件已删除，但浏览器刷新失败:');
  deps.emitStateChanged();
  return { ok: true, state: deps.getPublicState() };
}

/** @param {Record<string, any>} [deps] */
function createExtensionMutationService(deps = {}) {
  const runtime = /** @type {Record<string, any>} */ ({ ...deps, logger: deps.logger || console });
  return {
    setPluginEnabled: (id, enabled) => setPluginEnabled(runtime, id, enabled),
    importPlugin: (sourcePath) => importPlugin(runtime, sourcePath),
    removePlugin: (id) => removePlugin(runtime, id),
    isPluginEnabled: (id) => runtime.getPluginById(id)?.enabled === true,
  };
}

module.exports = { createExtensionMutationService };
