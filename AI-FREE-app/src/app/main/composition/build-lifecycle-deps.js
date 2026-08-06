// registerAppLifecycle 依赖装配（阶段 2D-3，自 bootstrap.js 原样迁出）。
'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { getStorePath, initializeCoreDirectory } = require('../config');
const { createHttpClient } = require('../lib/http-client');
const { shortcutManager } = require('../utils/removeWatermark');

function buildLifecycleDeps({
  app,
  fs,
  services,
  appShell,
  refreshAllowedPlatformsAndNotify,
  late,
}) {
  const {
    appRuntime,
    tabs,
    browserRuntimeManager,
    aiSandboxDir,
    browserAutomationBridge,
    aiServerDeviceService,
    licenseCache,
    browserPartitionCleaner,
    isDevMode,
    sendToSide,
    getAppConsoleHistory,
    getDebugConsoleHistory,
    licenseStore,
    serverResolver,
    tabHelpers,
    runtimeHelpers,
  } = services;

  const { setRuntimeServerBase, setRuntimeTcpConfig } = require('../config');

  return {
    app,
    ipcMain,
    fs,
    getStorePath,
    initializeCoreDirectory,
    getCurrentPlatformLabel: licenseStore.getCurrentPlatformLabel,
    readStoreConfigSafe: licenseStore.readStoreConfigSafe,
    writeStoreConfigSafe: licenseStore.writeStoreConfigSafe,
    writeLicenseRecordsSafe: licenseStore.writeLicenseRecordsSafe,
    readLicenseRecordsSafe: licenseStore.readLicenseRecordsSafe,
    computeDeviceId: runtimeHelpers.computeDeviceId,
    licenseCache,
    bootstrapMainApp: appShell.bootstrapMainApp,
    sendToSide,
    cleanupAllBrowserSessionData: browserPartitionCleaner.cleanupAllBrowserSessionData,
    cleanupBrowserPartitionsRootDir: browserPartitionCleaner.cleanupBrowserPartitionsRootDir,
    browserRuntimeManager,
    aiSandboxDir,
    browserAutomationBridge,
    aiServerDeviceService,
    getTabs: () => tabs,
    // AI 默认窗口工具需要的标签页/窗口操作桥。tabManager 的函数在 bootstrap
    // 中解构赋值，用箭头包装保持晚绑定。
    browserWindowUi: {
      getTabs: () => tabs,
      getActiveTabId: appRuntime.getActiveTabId,
      addTab: (...args) => late.getAddTab()(...args),
      switchTab: (...args) => late.getSwitchTab()(...args),
      closeTab: (...args) => late.getCloseTab()(...args),
      renameTab: (...args) => late.getRenameTab()(...args),
      setTabBrowserSettings: (...args) => late.getSetTabBrowserSettings()(...args),
      updateTabs: tabHelpers.updateTabs,
      sendToSide,
      browserRuntimeManager,
    },

    shortcutManager,
    authenticateAccount: serverResolver.authenticateAccount,
    applyResolvedConfigToStore: serverResolver.applyResolvedConfigToStore,
    refreshAnnouncements: appShell.refreshAnnouncements,
    refreshAllowedPlatformsAndNotify,
    setRuntimeServerBase,
    setRuntimeTcpConfig,
    createHttpClient,
    getGlobalHttpClient: appRuntime.getGlobalHttpClient,
    setGlobalHttpClient: appRuntime.setGlobalHttpClient,
    isSwitchingToLicense: appRuntime.getIsSwitchingToLicense,
    isMainBootstrapped: appRuntime.getIsMainBootstrapped,
    getLicenseWindow: appRuntime.getLicenseWindow,
    BrowserWindow,
    createMainWindow: appShell.createMainWindow,
    revealMainWindow: appShell.revealMainWindow,
    getMainWindow: appRuntime.getMainWindow,
    createDevConsoleWindow: appShell.createDevConsoleWindow,
    getAppConsoleHistory,
    getDebugConsoleHistory,
    isDevMode,
    logger: console,
  };
}

module.exports = { buildLifecycleDeps };
