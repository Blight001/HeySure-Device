// ensure-bundled.cjs
// tauri.conf.json declares `../bundled` as a bundle resource, so the Rust
// build script (tauri-build) errors with "resource path `..\bundled` doesn't
// exist" whenever the folder is missing. A full bundled Python runtime is only
// produced for packaged builds (prepare-bundled-python.cjs, ~150MB, gitignored).
// For `tauri dev` we don't need it — the Python runner resolves an interpreter
// from HEYSURE_PYTHON / the dev venv / PATH — so an empty folder is enough to
// satisfy the resource path. This runs as a pre-hook of tauri:dev.

const fs = require('fs')
const path = require('path')

const bundledDir = path.join(process.cwd(), 'bundled')

if (!fs.existsSync(bundledDir)) {
  fs.mkdirSync(bundledDir, { recursive: true })
  fs.writeFileSync(
    path.join(bundledDir, '.gitkeep'),
    '# Placeholder so `tauri dev` finds the ../bundled resource path.\n' +
      '# Packaged builds fill this with a full Python runtime via prepare:python.\n',
  )
  console.log('[ensure-bundled] created empty bundled/ for dev build')
}
