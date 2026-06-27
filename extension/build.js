// build.js — esbuild script for HeySure browser extension
import * as esbuild from 'esbuild'
import fs from 'fs'

const watch = process.argv.includes('--watch')

const sharedOpts = {
  bundle: true,
  minify: false,
  platform: 'browser',
  target: 'chrome119',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  // Suppress node built-ins warning from socket.io-client's unused paths
  logOverride: { 'unsupported-require-call': 'silent' },
}

const entries = [
  { in: 'src/background.ts',    out: 'dist/background.js' },
  { in: 'src/content/index.ts', out: 'dist/content.js' },
  { in: 'src/popup/index.ts',   out: 'dist/popup.js' },
  { in: 'src/offline-chat.ts',  out: 'dist/offline-chat.js' },
  { in: 'src/offscreen.ts',     out: 'dist/offscreen.js' },
]

// Avatar images are now served by the backend (/avatars/avatarsN.png) and
// fetched + cached at runtime, so they're no longer bundled with the extension.
const staticDirs = ['icons', 'cursors', 'src']

function ensureDist() {
  if (!fs.existsSync('dist')) fs.mkdirSync('dist', { recursive: true })
}

function stripDistPrefix(path) {
  return typeof path === 'string' ? path.replace(/^dist\//, '') : path
}

function writeDistManifest() {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'))

  if (manifest.background?.service_worker) {
    manifest.background.service_worker = stripDistPrefix(manifest.background.service_worker)
  }

  for (const script of manifest.content_scripts ?? []) {
    if (Array.isArray(script.js)) script.js = script.js.map(stripDistPrefix)
    if (Array.isArray(script.css)) script.css = script.css.map(stripDistPrefix)
  }

  fs.writeFileSync('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
}

function writeDistPopup() {
  const html = fs.readFileSync('popup.html', 'utf8')
    .replace(/<script\s+src=["']dist\/popup\.js["']><\/script>/, '<script src="popup.js"></script>')

  fs.writeFileSync('dist/popup.html', html)
}

function writeDistOfflineChat() {
  const html = fs.readFileSync('offline-chat.html', 'utf8')
    .replace(/<script\s+src=["']dist\/offline-chat\.js["']><\/script>/, '<script src="offline-chat.js"></script>')

  fs.writeFileSync('dist/offline-chat.html', html)
}

function writeDistOffscreen() {
  const html = fs.readFileSync('offscreen.html', 'utf8')
    .replace(/<script\s+src=["']dist\/offscreen\.js["']><\/script>/, '<script src="offscreen.js"></script>')

  fs.writeFileSync('dist/offscreen.html', html)
}

function copyStaticAssets() {
  ensureDist()
  writeDistManifest()
  writeDistPopup()
  writeDistOfflineChat()
  writeDistOffscreen()

  for (const dir of staticDirs) {
    if (!fs.existsSync(dir)) continue
    fs.rmSync(`dist/${dir}`, { recursive: true, force: true })
    fs.cpSync(dir, `dist/${dir}`, { recursive: true })
  }
}

ensureDist()

if (watch) {
  const ctx = await esbuild.context({
    ...sharedOpts,
    entryPoints: entries.map(e => e.in),
    outdir: 'dist',
  })
  copyStaticAssets()
  await ctx.watch()
  console.log('[esbuild] watching for changes…')
} else {
  for (const entry of entries) {
    await esbuild.build({ ...sharedOpts, entryPoints: [entry.in], outfile: entry.out })
    console.log(`  built ${entry.in} → ${entry.out}`)
  }
  copyStaticAssets()
  console.log('[esbuild] build complete ✓')
}
