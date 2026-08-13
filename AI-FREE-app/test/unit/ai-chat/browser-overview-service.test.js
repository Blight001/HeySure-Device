'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBrowserOverview } = require('../../../src/app/main/services/browser-overview-service');

test('browser overview combines records, open-window tabs and a bounded workspace tree', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-overview-'));
  fs.mkdirSync(path.join(workspace, 'reports'));
  fs.writeFileSync(path.join(workspace, 'reports', 'exam.txt'), 'ready');
  try {
    const result = await createBrowserOverview({
      workspaceDir: workspace,
      records: [
        { id: 'history-1', name: '考试窗口', isOpen: true, profileId: 'profile-a' },
        { id: 'history-2', name: '资料窗口', isOpen: false, profileId: 'profile-b' },
      ],
      connections: [
        { id: 'native:profile-a', profileId: 'profile-a', name: '考试窗口', online: true },
        { id: 'native:profile-c', profileId: 'profile-c', name: '异常窗口', online: true },
      ],
      listTabs: async (connection) => {
        if (connection.profileId === 'profile-c') throw new Error('桥接暂时不可用');
        return {
          activeTabId: '1',
          tabs: [
            { id: '0', title: '考试首页', url: 'https://exam.test/', active: false },
            { id: '1', title: '答题页面', url: 'https://exam.test/paper', active: true },
          ],
        };
      },
    }, { workspace_depth: 3, workspace_max_entries: 100 });

    assert.equal(result.browser_record_count, 2);
    assert.equal(result.open_browser_count, 1);
    assert.equal(result.connected_browser_count, 2);
    assert.equal(result.open_browser_records[0].name, '考试窗口');
    assert.deepEqual(result.connected_browsers[0].tabs.map((item) => item.title), ['考试首页', '答题页面']);
    assert.match(result.connected_browsers[1].error, /桥接暂时不可用/);
    assert.equal(result.workspace.tree[0].children[0].name, 'exam.txt');
    assert.equal(result.workspace.tree[0].children[0].size, 5);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
