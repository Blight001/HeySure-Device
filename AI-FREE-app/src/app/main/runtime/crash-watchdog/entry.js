'use strict';

const fs = require('fs');
const path = require('path');

const { CrashWatchdogWorker } = require('./worker');
const { isoNow } = require('./shared');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    result[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return result;
}

function appendDiagnostic(rootDir, message) {
  try {
    const logPath = path.join(rootDir, 'watchdog.log');
    const stat = fs.existsSync(logPath) ? fs.statSync(logPath) : null;
    if (stat?.size > 512 * 1024) fs.renameSync(logPath, `${logPath}.previous`);
    fs.appendFileSync(logPath, `[${isoNow()}] ${String(message).slice(0, 2000)}\n`, 'utf8');
  } catch (_) {}
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.root || !options.session || !Number(options.parentPid)) {
    throw new Error('crash watchdog requires --root, --session and --parent-pid');
  }
  const worker = new CrashWatchdogWorker({
    rootDir: path.resolve(options.root),
    sessionPath: path.resolve(options.session),
    parentPid: Number(options.parentPid),
    pollMs: Number(options.pollMs) || undefined,
    retryMs: Number(options.retryMs) || undefined,
    dumpSettleMs: Number(options.dumpSettleMs) || undefined,
    postExitMs: Number(options.postExitMs) || undefined,
    onDiagnostic: (message) => appendDiagnostic(options.root, message),
  });
  return worker.run();
}

if (require.main === module) {
  main().catch((error) => {
    const options = parseArgs(process.argv.slice(2));
    appendDiagnostic(options.root || process.cwd(), `看门狗退出: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
