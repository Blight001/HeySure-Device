const path = require('path');

if (process.platform !== 'win32') {
  throw new Error('@ai-free/browser-host 仅支持 Windows');
}

module.exports = require(path.join(__dirname, 'build', 'Release', 'browser_host.node'));
