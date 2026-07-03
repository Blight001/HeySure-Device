// Create the device Python runtime venv and install requirements.
//
// Run from a desktop shell directory with `npm run setup:python`. Safe to
// re-run; it reuses an existing venv and reapplies requirements.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const pyDir = path.join(root, 'device_runtime', 'python')
const venvDir = path.join(pyDir, '.venv')
const requirements = path.join(pyDir, 'requirements.txt')
const isWin = process.platform === 'win32'
const venvPython = path.join(venvDir, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python')

function findBasePython() {
  const candidates = isWin ? ['py', 'python', 'python3'] : ['python3', 'python']
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' })
    if (!r.error && r.status === 0) return cmd
  }
  return null
}

function run(cmd, args) {
  console.log(`[setup-python] ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error || r.status !== 0) {
    console.error(`[setup-python] command failed: ${cmd} ${args.join(' ')}`)
    process.exit(1)
  }
}

if (!fs.existsSync(requirements)) {
  console.error(`[setup-python] requirements not found: ${requirements}`)
  process.exit(1)
}

if (!fs.existsSync(venvPython)) {
  const base = findBasePython()
  if (!base) {
    console.error('[setup-python] no Python found on PATH (need python3). Install Python 3 first.')
    process.exit(1)
  }
  run(base, ['-m', 'venv', venvDir])
}

run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])
run(venvPython, ['-m', 'pip', 'install', '-r', requirements])
console.log(`[setup-python] ready: ${venvPython}`)
