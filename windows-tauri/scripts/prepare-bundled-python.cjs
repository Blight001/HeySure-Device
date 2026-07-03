// prepare-bundled-python.cjs
// Prepares a self-contained Python runtime for packaged Tauri app (Windows).
// - Downloads official embeddable Python zip (no system Python needed on target machine).
// - Configures it for pip/site.
// - Installs the requirements.txt from device_runtime/python/.
// Run automatically as part of `npm run package` (see windows/package.json).
// Output: <shell-root>/bundled/python/  (python.exe + stdlib + site-packages + deps)
//
// NOTE: This runs only on the *packaging machine* (dev/CI). Resulting folder
// is large (~150MB+) and is .gitignored. The final installer ships it via extraResources.

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { pipeline } = require('stream')
const { promisify } = require('util')

const pipelineAsync = promisify(pipeline)

const root = process.cwd()
const bundledDir = path.join(root, 'bundled')
const pythonDir = path.join(bundledDir, 'python')
const requirementsPath = path.join(root, 'device_runtime', 'python', 'requirements.txt')

// Pinned Python version with good wheel support for the automation libs.
// 3.10 chosen for maximum compatibility with pyautogui/pywinauto/pynput stack.
const PY_VER = '3.10.11'
const PY_MAJOR_MINOR = '310'
const PY_ZIP_NAME = `python-${PY_VER}-embed-amd64.zip`
const PY_URL = `https://www.python.org/ftp/python/${PY_VER}/${PY_ZIP_NAME}`
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

function log(msg) {
  console.log(`[prepare-bundled-python] ${msg}`)
}

function run(cmd, args, opts = {}) {
  log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts })
  if (r.error || (r.status !== 0 && r.status !== null)) {
    console.error(`[prepare-bundled-python] Command failed: ${cmd} ${args.join(' ')}`)
    if (r.error) console.error(r.error)
    process.exit(1)
  }
}

async function download(url, dest) {
  log(`Downloading ${url}`)
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect (python.org sometimes redirects)
        file.close()
        fs.unlinkSync(dest)
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      pipelineAsync(res, file).then(resolve).catch(reject)
    })
    req.on('error', (e) => {
      try { file.close() } catch {}
      reject(e)
    })
  })
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function filesEqual(a, b) {
  try {
    return fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8')
  } catch {
    return false
  }
}

async function main() {
  if (process.platform !== 'win32') {
    log('Bundled Python preparation is currently implemented for Windows packaging only. Skipping on this platform.')
    return
  }

  if (!fs.existsSync(requirementsPath)) {
    console.error(`[prepare-bundled-python] requirements.txt not found at ${requirementsPath}`)
    process.exit(1)
  }

  // Fast path: already prepared for this exact Python + requirements
  const markerPath = path.join(pythonDir, '.heysure-python-marker')
  const expectedMarker = `${PY_VER}\n${fs.readFileSync(requirementsPath, 'utf8').trim()}\n`
  const pyExe = path.join(pythonDir, 'python.exe')
  if (fs.existsSync(pyExe) && fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8') === expectedMarker) {
    log('Bundled Python already prepared and up-to-date. Skipping download/install.')
    return
  }

  log(`Preparing self-contained Python ${PY_VER} for distribution... (this may take a few minutes on first run)`)

  // Clean previous
  if (fs.existsSync(bundledDir)) {
    fs.rmSync(bundledDir, { recursive: true, force: true })
  }
  ensureDir(bundledDir)
  ensureDir(pythonDir)

  const zipPath = path.join(bundledDir, PY_ZIP_NAME)
  await download(PY_URL, zipPath)

  log('Extracting embeddable Python...')
  // Use PowerShell (guaranteed on Windows build machines)
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath "${zipPath.replace(/\\/g, '\\\\')}" -DestinationPath "${pythonDir.replace(/\\/g, '\\\\')}" -Force`
  ])

  try { fs.unlinkSync(zipPath) } catch {}

  // Patch the ._pth to enable site + imports (critical for pip + packages)
  const pthName = `python${PY_MAJOR_MINOR}._pth`
  const pthPath = path.join(pythonDir, pthName)
  if (fs.existsSync(pthPath)) {
    let content = fs.readFileSync(pthPath, 'utf8')
    // Enable import site (remove leading #)
    content = content.replace(/^#.*import site.*$/im, 'import site')
    if (!/^\s*import site\s*$/im.test(content)) {
      content = content.trim() + '\nimport site\n'
    }
    // Make sure current dir is on path
    if (!/^\s*\.\s*$/m.test(content)) {
      content = '.\n' + content
    }
    fs.writeFileSync(pthPath, content)
    log(`Patched ${pthName}`)
  } else {
    // Fallback pth
    fs.writeFileSync(pthPath, '.\npython310.zip\n\nimport site\n')
    log('Created fallback pth')
  }

  // Get pip
  const getPipPath = path.join(pythonDir, 'get-pip.py')
  await download(GET_PIP_URL, getPipPath)

  log('Bootstrapping pip...')
  run(pyExe, ['-E', getPipPath, '--no-warn-script-location', '--no-cache-dir', '-q'], { cwd: pythonDir })

  try { fs.unlinkSync(getPipPath) } catch {}

  // Install the device runtime requirements (pyautogui, pillow, pywinauto, etc.)
  log('Installing Python packages for runtime tools (pyautogui, pynput, pywinauto, mss, pillow, psutil, ...). This can take several minutes...')
  run(pyExe, [
    '-m', 'pip', 'install',
    '--no-warn-script-location',
    '--no-cache-dir',
    '--disable-pip-version-check',
    '-r', requirementsPath
  ], { cwd: pythonDir })

  // Write marker so we can skip on subsequent package runs if nothing changed
  fs.writeFileSync(markerPath, expectedMarker)

  // Quick sanity
  if (!fs.existsSync(pyExe)) {
    console.error('[prepare-bundled-python] python.exe missing after setup')
    process.exit(1)
  }

  log(`Bundled Python ready: ${pyExe}`)
  log('It will be included in the installer via extraResources.')
}

main().catch((err) => {
  console.error('[prepare-bundled-python] Failed:', err)
  process.exit(1)
})
