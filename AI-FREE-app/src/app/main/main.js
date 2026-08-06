// 崩溃保护必须先于所有业务 require；否则启动模块加载失败时只会闪退且没有日志。
const { app, crashReporter, ipcMain } = require('electron');
const { installEarlyCrashReporter } = require('./runtime/crash-reporter');

installEarlyCrashReporter({ app, crashReporter, ipcMain });
require('./entry/start-app');
