// artifact-bridge — controlled return path for binary / file outputs.
//
// Server-authored tools produce screenshots, files and structured blobs. Rather
// than letting them write anywhere, the bridge funnels everything through one
// artifacts directory with a hard size cap (设备端MCP代码下放长期方案 §7.1:
// "artifact 必须有大小上限"). The host injects the base directory at startup
// (e.g. app.getPath('userData')/artifacts); until then it falls back to the OS
// temp dir so the module never hard-depends on Electron.

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { ARTIFACT_MAX_BYTES, FS_READ_LIMIT_BYTES } from '../constants'

let baseDir = ''

export function initArtifactBridge(dir: string): void {
  baseDir = dir
  ensureBase()
}

function ensureBase(): string {
  if (!baseDir) baseDir = path.join(os.tmpdir(), 'heysure-artifacts')
  fs.mkdirSync(baseDir, { recursive: true })
  return baseDir
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv',
  '.html': 'text/html', '.pdf': 'application/pdf', '.zip': 'application/zip',
}

function guessMime(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function safeName(name: string): string {
  const base = path.basename(String(name || 'artifact')).replace(/[^A-Za-z0-9._-]/g, '_')
  return base || 'artifact'
}

export interface Artifact {
  id: string
  path: string
  name: string
  size: number
  mime: string
  sha256: string
  createdAt: number
}

export interface SaveOptions {
  mime?: string
  maxBytes?: number
}

/** Persist a buffer / string into the artifacts dir. Throws past the size cap. */
export function saveArtifact(name: string, data: Buffer | string, options: SaveOptions = {}): Artifact {
  const dir = ensureBase()
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const cap = options.maxBytes ?? ARTIFACT_MAX_BYTES
  if (buffer.length > cap) {
    throw new Error(`artifact 超过大小上限 (${buffer.length} > ${cap} bytes)`)
  }
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')
  const fileName = `${id}-${safeName(name)}`
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, buffer)
  return {
    id,
    path: filePath,
    name: safeName(name),
    size: buffer.length,
    mime: options.mime || guessMime(fileName),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    createdAt: Date.now(),
  }
}

export function saveBase64Artifact(name: string, base64: string, mime?: string): Artifact {
  return saveArtifact(name, Buffer.from(String(base64 || ''), 'base64'), { mime })
}

export interface FileArtifactResult {
  path: string
  size: number
  mime: string
  base64: string
  truncated: boolean
}

/** Read an existing file back as an artifact descriptor, capping the payload. */
export function readFileArtifact(filePath: string, options: { maxBytes?: number } = {}): FileArtifactResult {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`file not found: ${resolved}`)
  }
  const cap = options.maxBytes ?? ARTIFACT_MAX_BYTES
  const size = fs.statSync(resolved).size
  const buffer = fs.readFileSync(resolved)
  const truncated = buffer.length > cap
  const payload = truncated ? buffer.subarray(0, cap) : buffer
  return {
    path: resolved,
    size,
    mime: guessMime(resolved),
    base64: payload.toString('base64'),
    truncated,
  }
}

/** Read a UTF-8 text file with the smaller text cap; for logs / structured output. */
export function readTextArtifact(filePath: string, options: { maxBytes?: number } = {}): { path: string; size: number; text: string; truncated: boolean } {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`file not found: ${resolved}`)
  }
  const cap = options.maxBytes ?? FS_READ_LIMIT_BYTES
  const size = fs.statSync(resolved).size
  const buffer = fs.readFileSync(resolved)
  const truncated = buffer.length > cap
  return {
    path: resolved,
    size,
    text: (truncated ? buffer.subarray(0, cap) : buffer).toString('utf8'),
    truncated,
  }
}

/** Delete artifacts older than maxAgeMs (default 24h). Returns count removed. */
export function pruneArtifacts(maxAgeMs = 24 * 60 * 60 * 1000): number {
  const dir = ensureBase()
  let removed = 0
  const now = Date.now()
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry)
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.rmSync(file, { force: true }); removed += 1 }
    } catch { /* ignore */ }
  }
  return removed
}
