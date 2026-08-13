'use strict';

const fs = require('fs');
const path = require('path');

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : fallback;
}

function publicRecord(item = {}) {
  return {
    history_id: String(item.id || item.history_id || ''),
    name: String(item.name || ''),
    url: String(item.url || ''),
    is_open: item.isOpen === true || item.is_open === true,
    is_active: item.isActive === true || item.is_active === true,
    profile_id: String(item.profileId || item.profile_id || ''),
    tab_id: String(item.tabId || item.tab_id || ''),
    last_opened_at: Number(item.lastOpenedAt || item.last_opened_at) || 0,
  };
}

async function directoryEntries(root, current, depth, limits, counter) {
  if (depth > limits.depth || counter.value >= limits.entries) return [];
  let children;
  try {
    children = await fs.promises.readdir(current, { withFileTypes: true });
  } catch (error) {
    return [{ name: path.basename(current), type: 'unreadable', error: error?.code || 'READ_FAILED' }];
  }
  children.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory())
    || left.name.localeCompare(right.name, 'zh-CN'));
  const result = [];
  for (const child of children) {
    if (counter.value >= limits.entries) break;
    counter.value += 1;
    const absolutePath = path.join(current, child.name);
    const relativePath = path.relative(root, absolutePath);
    if (child.isDirectory()) {
      result.push({
        name: child.name, path: relativePath, type: 'directory',
        children: depth < limits.depth
          ? await directoryEntries(root, absolutePath, depth + 1, limits, counter) : [],
      });
    } else {
      let size = 0;
      try { size = child.isFile() ? (await fs.promises.stat(absolutePath)).size : 0; } catch (_) {}
      result.push({
        name: child.name, path: relativePath,
        type: child.isFile() ? 'file' : (child.isSymbolicLink() ? 'symlink' : 'other'),
        ...(child.isFile() ? { size } : {}),
      });
    }
  }
  return result;
}

async function workspaceOverview(workspaceDir, args = {}) {
  const depth = boundedInteger(args.workspace_depth, 4, 1, 8);
  const maxEntries = boundedInteger(args.workspace_max_entries, 500, 10, 2000);
  const root = path.resolve(String(workspaceDir || 'AI-Workspace'));
  const counter = { value: 0 };
  const tree = await directoryEntries(root, root, 1, { depth, entries: maxEntries }, counter);
  return {
    root, depth, max_entries: maxEntries, entry_count: counter.value,
    truncated: counter.value >= maxEntries, tree,
  };
}

async function createBrowserOverview(options = {}, args = {}) {
  const connections = Array.isArray(options.connections) ? options.connections : [];
  const windows = await Promise.all(connections.map(async (connection) => {
    try {
      const tabs = await options.listTabs(connection);
      return {
        connection_id: connection.id, profile_id: connection.profileId, name: connection.name,
        online: connection.online === true, active_tab_id: String(tabs?.activeTabId || ''),
        tabs: Array.isArray(tabs?.tabs) ? tabs.tabs : [],
      };
    } catch (error) {
      return {
        connection_id: connection.id, profile_id: connection.profileId, name: connection.name,
        online: connection.online === true, tabs: [], error: error?.message || String(error),
      };
    }
  }));
  const records = (Array.isArray(options.records) ? options.records : []).map(publicRecord);
  const openRecords = records.filter((item) => item.is_open);
  return {
    success: true, action: 'overview', readOnly: true,
    browser_record_count: records.length, open_browser_count: openRecords.length,
    connected_browser_count: windows.length,
    browser_records: records, open_browser_records: openRecords, connected_browsers: windows,
    workspace: await workspaceOverview(options.workspaceDir, args),
  };
}

module.exports = { createBrowserOverview, workspaceOverview };
