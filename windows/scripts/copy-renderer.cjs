const fs = require('fs')
const path = require('path')

const root = process.cwd()
const srcDir = path.join(root, 'src', 'renderer')
const outDir = path.join(root, 'dist', 'renderer')

fs.mkdirSync(outDir, { recursive: true })

for (const file of ['index.html', 'offline-chat.html', 'remote-control.html']) {
  const src = path.join(srcDir, file)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(outDir, file))
  }
}
