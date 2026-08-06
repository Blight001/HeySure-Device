'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const zlib = require('node:zlib');

function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('watchdog test timed out'));
    }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`watchdog exited with code=${code} signal=${signal}`));
    });
  });
}

async function listenForReports(received) {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString('utf8')));
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end('{"success":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('detached watchdog uploads logs and a nested Crashpad dump after the main process is gone', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-watchdog-test-'));
  const rootDir = path.join(tempDir, 'crash-reports');
  const sessionsDir = path.join(rootDir, 'sessions');
  const reportsDir = path.join(rootDir, 'dumps', 'reports');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const received = [];
  const server = await listenForReports(received);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const eventTime = new Date().toISOString();
  const logPath = path.join(tempDir, 'run.log');
  const dumpPath = path.join(reportsDir, 'native-crash.dmp');
  fs.writeFileSync(logPath, 'before crash\npassword=hunter2\nlast native line', 'utf8');
  fs.writeFileSync(dumpPath, Buffer.from('MDMP-test-dump'));

  const sessionPath = path.join(sessionsDir, 'crashed-session.json');
  fs.writeFileSync(sessionPath, JSON.stringify({
    sessionId: 'crashed-session',
    installationId: 'test-installation',
    appMetadata: { appName: 'AI-FREE', appVersion: 'test-version', platform: 'win32', arch: 'x64' },
    startedAt: eventTime,
    lastSeenAt: eventTime,
    cleanExit: false,
    reportedCrash: false,
    fatalIncidentRecorded: false,
    startupPhase: 'app-ready',
    pid: 2147483647,
    logFilePath: logPath,
    serverBase: `http://127.0.0.1:${address.port}`,
  }), 'utf8');

  const entryPath = path.join(
    __dirname, '..', '..', 'src', 'app', 'main', 'runtime', 'crash-watchdog', 'entry.js',
  );
  const child = spawn(process.execPath, [
    entryPath,
    '--root', rootDir,
    '--session', sessionPath,
    '--parent-pid', '2147483647',
    '--poll-ms', '20',
    '--retry-ms', '40',
    '--dump-settle-ms', '60',
    '--post-exit-ms', '3000',
  ], { windowsHide: true, stdio: 'ignore' });
  await waitForExit(child);

  assert.equal(received.length, 1);
  const report = received[0];
  assert.equal(report.type, 'abnormal-exit');
  assert.equal(report.details.recoverySource, 'independent-watchdog');
  assert.match(report.logs[0].content, /before crash/);
  assert.match(report.logs[0].content, /last native line/);
  assert.doesNotMatch(report.logs[0].content, /hunter2/);
  assert.equal(Buffer.from(report.nativeDump.content, 'base64').toString(), 'MDMP-test-dump');
  assert.equal(fs.readdirSync(path.join(rootDir, 'pending')).length, 0);
  const finalSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(finalSession.reportedCrash, true);
  assert.ok(finalSession.reportId);
});
