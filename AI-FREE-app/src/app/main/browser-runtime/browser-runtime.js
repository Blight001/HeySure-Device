const { EventEmitter } = require('events');

class BrowserRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
  }

  async launchProfile() { throw new Error('launchProfile() is not implemented'); }
  async attach() { throw new Error('attach() is not implemented'); }
  async show() { throw new Error('show() is not implemented'); }
  async hide() { throw new Error('hide() is not implemented'); }
  async resize() { throw new Error('resize() is not implemented'); }
  async focus() { throw new Error('focus() is not implemented'); }
  async getState() { throw new Error('getState() is not implemented'); }
  async reload() { throw new Error('reload() is not implemented'); }
  async importSession() { throw new Error('importSession() is not implemented'); }
  async stop() { throw new Error('stop() is not implemented'); }
}

module.exports = { BrowserRuntime };
