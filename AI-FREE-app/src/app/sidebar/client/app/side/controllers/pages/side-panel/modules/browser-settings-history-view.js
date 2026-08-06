'use strict';

class AiFreeBrowserHistoryView {
constructor({
  el,
  getBrowserHistory,
  getBrowserProfileAudit,
  openBrowserHistory,
  selectBrowserHistory,
}) {
    Object.assign(this, { el, getBrowserHistory, getBrowserProfileAudit, openBrowserHistory, selectBrowserHistory });
    for (const name of [
      'renderBrowserHistory', 'renderBrowserProfileAudit', 'formatBrowserHistoryDateTime',
    ]) this[name] = this[name].bind(this);
  }

  appendAccountMetadata(main, item) {
    const parts = [];
    if (item.accountDisplayName) parts.push(`账号：${item.accountDisplayName}`);
    if (item.accountTypeLabel) parts.push(item.accountTypeLabel);
    if (parts.length) {
      const accountMeta = document.createElement('span');
      accountMeta.className = 'browser-history-account-meta';
      accountMeta.textContent = parts.join(' · ');
      main.append(accountMeta);
    }
    if (item.accountType === 'shared') {
      const autoDelete = document.createElement('span');
      autoDelete.className = 'browser-history-account-meta browser-history-auto-delete';
      autoDelete.textContent = `自动删除：${this.formatBrowserHistoryDateTime(item.autoDeleteAt) || '等待服务器同步'}`;
      main.append(autoDelete);
    }
  }

  renderBrowserHistory() {
    const list = this.el('browser-history-list');
    if (!list) return;
    list.replaceChildren();
    if (!this.getBrowserHistory().length) {
      const empty = document.createElement('div');
      empty.className = 'browser-history-empty';
      empty.textContent = '暂无浏览器记录，点击窗口栏的“+”新建。';
      list.appendChild(empty);
      return;
    }
    this.getBrowserHistory().forEach((item) => {
      const row = document.createElement('div');
      row.className = 'browser-history-item';
      row.classList.toggle('is-open', item.isOpen === true);
      row.classList.toggle('is-active', item.isActive === true);
      row.classList.toggle('has-error', !!item.lastError);
      row.dataset.historyId = item.id;
  
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'browser-history-main';
      main.title = `${item.name || '未命名浏览器'}（单击打开）`;
      main.setAttribute('aria-label', `${item.name || '未命名浏览器'}，${item.isActive ? '当前浏览器' : (item.isOpen ? '已打开' : '已关闭')}，单击打开`);
      const name = document.createElement('span');
      name.className = 'browser-history-name';
      name.textContent = item.name || '未命名浏览器';
      main.append(name);
      this.appendAccountMetadata(main, item);
      main.addEventListener('click', () => void this.openBrowserHistory(item.id, main));
  
      const actions = document.createElement('div');
      actions.className = 'browser-history-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'browser-history-action browser-history-edit';
      edit.textContent = '编辑';
      edit.title = '编辑名称、参数或删除浏览器';
      edit.addEventListener('click', () => void this.selectBrowserHistory(item.id, { openDialog: true }));
      actions.append(edit);
      row.append(main, actions);
      list.appendChild(row);
    });
  }
  
  renderBrowserProfileAudit() {
    const audit = this.el('browser-profile-audit');
    const totalCount = Number(this.getBrowserProfileAudit()?.totalCount || 0);
    if (audit) {
      audit.hidden = !this.getBrowserProfileAudit();
      audit.textContent = this.getBrowserProfileAudit()
        ? `环境 ${totalCount}`
        : '';
    }
  }
  
  formatBrowserHistoryDateTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

window.createAiFreeBrowserHistoryView = function createAiFreeBrowserHistoryView(dependencies) {
  return new AiFreeBrowserHistoryView(dependencies);
};
