// Copies single-source-of-truth shared files into the current desktop shell
// before TypeScript compiles. Run from device/windows, device/linux, or
// device/mac via `node ../shared/scripts/sync-shared.js`.
const fs = require('fs')
const path = require('path')

const shellRoot = process.cwd()
const sharedRoot = path.join(__dirname, '..')

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

function syncDir(label, from, to) {
  if (!fs.existsSync(from)) {
    console.error(`[sync-shared] ${label} not found: ${from}`)
    process.exit(1)
  }
  copyDir(from, to)
}

syncDir('shared source', path.join(sharedRoot, 'src'), path.join(shellRoot, 'src'))
syncDir('shared assets', path.join(sharedRoot, 'assets'), path.join(shellRoot, 'assets'))

console.log('[sync-shared] synced shared/src -> src and shared/assets -> assets')
