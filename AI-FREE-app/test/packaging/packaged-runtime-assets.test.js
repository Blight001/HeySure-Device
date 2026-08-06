const { readAiControlSource } = require('../helpers/source-bundles');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../../package.json');
const { resolveBindingCandidates } = require('../../src/app/main/browser-runtime/chromium-window-bridge');
const { assertStaticVCRuntime } = require('../../scripts/verify-packaged-runtime');

test('packaged native browser host resolves from external resources first', () => {
  const resourcesPath = path.resolve('C:/AI-FREE/resources');
  const appRoot = path.join(resourcesPath, 'app.asar');
  const candidates = resolveBindingCandidates({ resourcesPath, appRoot });

  assert.equal(
    candidates[0],
    path.join(resourcesPath, 'native', 'browser-host', 'browser_host.node'),
  );
  assert.ok(candidates.indexOf(path.join(appRoot, 'native', 'browser-host', 'build', 'Release', 'browser_host.node')) > 0);
});

test('staged development app resolves the native browser host from the project root', () => {
  const projectRoot = path.resolve('D:/workspace/ai-free');
  const appRoot = path.join(projectRoot, '.generated', 'app');
  const candidates = resolveBindingCandidates({
    appRoot,
    resourcesPath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'resources'),
    workingDirectory: projectRoot,
  });

  assert.ok(candidates.includes(
    path.join(projectRoot, 'native', 'browser-host', 'build', 'Release', 'browser_host.node'),
  ));
});

test('native host and runtime logo are packaged only as external resources', () => {
  const files = packageJson.build.files || [];
  const extraResources = packageJson.build.extraResources || [];

  assert.equal(files.includes('native/browser-host/build/Release/browser_host.node'), false);
  assert.ok(files.includes('!src/assets/logo.ico'));
  assert.ok(extraResources.some((entry) => (
    entry.from === 'native/browser-host/build/Release/browser_host.node'
      && entry.to === 'native/browser-host/browser_host.node'
  )));
  assert.ok(extraResources.some((entry) => (
    entry.from === 'src/assets/logo.ico' && entry.to === 'resource/logo.ico'
  )));
});

test('native host has no external VC++ redistributable dependency', () => {
  assert.doesNotThrow(() => assertStaticVCRuntime(
    path.join(__dirname, '../../native/browser-host/build/Release/browser_host.node'),
  ));
  assert.match(packageJson.scripts.build, /build:native-host/);
  assert.match(packageJson.scripts['build:portable'], /build:native-host/);
});

test('sidebar logos use the runtime asset resolver in source and packaged apps', () => {
  const sidebarRoot = path.join(__dirname, '../../src/app/sidebar');
  const index = fs.readFileSync(path.join(sidebarRoot, 'index.html'), 'utf8');
  const aiControlPage = fs.readFileSync(path.join(sidebarRoot, 'ai-control.html'), 'utf8');
  const accountCenterPage = fs.readFileSync(path.join(sidebarRoot, 'account-center.html'), 'utf8');
  const appShell = fs.readFileSync(path.join(__dirname, '../../src/app/views/app-shell.html'), 'utf8');
  const accountAuthCss = fs.readFileSync(
    path.join(sidebarRoot, 'client/app/side/styles/modules/account-auth.css'),
    'utf8',
  );
  const layoutCss = fs.readFileSync(
    path.join(sidebarRoot, 'client/app/side/styles/modules/layout.css'),
    'utf8',
  );
  const logoResolver = fs.readFileSync(
    path.join(__dirname, '../../src/app/sidebar/client/scripts/logo-assets.js'),
    'utf8',
  );
  const aiControl = readAiControlSource();

  assert.ok(index.includes("location.replace('./ai-control.html')"));
  for (const html of [aiControlPage, accountCenterPage]) {
    assert.ok(html.includes('<script src="./client/scripts/logo-assets.js"></script>'));
  }
  assert.equal((aiControlPage.match(/<img[^>]*data-app-logo/g) || []).length, 1);
  assert.equal((accountCenterPage.match(/<img[^>]*data-app-logo/g) || []).length, 1);
  assert.ok(logoResolver.includes("const SOURCE_LOGO_PATH = '../../assets/logo.ico';"));
  assert.ok(logoResolver.includes("const PACKAGED_LOGO_PATH = '../../../../resource/logo.ico';"));
  assert.ok(aiControl.includes('window.aiFreeLogoAssets?.url'));
  assert.equal(appShell.includes('id="account-center-btn"'), false);
  assert.ok(aiControlPage.includes('data-tab="account-center-panel"'));
  assert.ok(accountCenterPage.includes('id="account-center-panel"'));
  assert.ok(appShell.includes('../sidebar/client/scripts/logo-assets.js'));
  assert.ok(appShell.includes('id="ai-free-settings-panel"'));
  assert.ok(appShell.includes('id="browser-settings-tutorial"'));
  assert.ok(appShell.includes('id="automation-workbench"'));
  assert.ok(appShell.includes('id="automation-flow-canvas"'));
  assert.ok(appShell.includes('id="automation-node-inspector"'));
  assert.ok(appShell.includes('shell-automation-canvas.js'));
  assert.ok(appShell.includes('shell-automation-workbench.js'));
  assert.ok(appShell.includes('app-shell-automation-canvas.css'));
  assert.ok(appShell.includes('app-shell-automation.css'));
  assert.match(accountAuthCss, /\.account-center-panel\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(accountAuthCss, /\.account-center-panel \.container\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(layoutCss, /#browser-empty-state::\-webkit-scrollbar-thumb/);
});
