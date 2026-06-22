// Screen capture using Electron's main-process desktopCapturer + screen modules.
//
// The previous implementation hosted a hidden BrowserWindow and called
// `require('electron').screen` from the renderer. In Electron 17+ both
// `screen` and `desktopCapturer` are main-process-only, so the renderer
// approach failed at runtime with "screen.getPrimaryDisplay is not a
// function". Running directly in main removes the IPC hop entirely.

import { desktopCapturer, screen } from 'electron'
import { SCREENSHOT_TIMEOUT_MS } from './constants'

export interface CaptureOpts {
  width?: number
  height?: number
  displayIndex?: number
  cropRegion?: { x: number; y: number; width: number; height: number }
}

export interface CaptureDisplayGeometry {
  id: number
  scaleFactor: number
  bounds: { x: number; y: number; width: number; height: number }
  size: { width: number; height: number }
}

function robotScreenSize(): { width: number; height: number } | null {
  try {
    const robot = require('robotjs')
    const size = robot.getScreenSize?.()
    const width = Math.round(Number(size?.width))
    const height = Math.round(Number(size?.height))
    if (width > 0 && height > 0) return { width, height }
  } catch {
    // robotjs may be unavailable in non-desktop test environments.
  }
  return null
}

function defaultCaptureSize(display: Electron.Display, displayCount: number): { width: number; height: number } {
  const robotSize = robotScreenSize()
  if (robotSize && displayCount <= 1) return robotSize

  return {
    width: Math.round(display.bounds.width),
    height: Math.round(display.bounds.height),
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    )
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

export async function executeCapture(opts: CaptureOpts = {}): Promise<Buffer> {
  const displays = screen.getAllDisplays()
  const requested = opts.displayIndex ?? 0
  const idx = displays.length > 0
    ? Math.min(Math.max(requested, 0), displays.length - 1)
    : 0
  const display = displays[idx] || screen.getPrimaryDisplay()

  // Keep screenshots in the same coordinate space used by robotjs mouse APIs.
  // This avoids DPI scaling mismatches where native screenshots are larger than
  // the coordinates accepted by mouse.click.
  const defaultSize = defaultCaptureSize(display, displays.length)
  const w = opts.width ?? defaultSize.width
  const h = opts.height ?? defaultSize.height

  const sources = await withTimeout(
    desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h },
    }),
    SCREENSHOT_TIMEOUT_MS,
    'Screenshot',
  )
  if (sources.length === 0) throw new Error('No screen sources available')

  // Prefer the source whose display_id matches the requested display; fall
  // back to positional index, then to the first source.
  const source = sources.find(s => s.display_id === String(display.id))
    || sources[idx]
    || sources[0]

  let img = source.thumbnail
  if (opts.cropRegion) img = img.crop(opts.cropRegion)
  return img.toPNG()
}

export function getCaptureDisplayGeometry(displayIndex = 0): CaptureDisplayGeometry {
  const displays = screen.getAllDisplays()
  const idx = displays.length > 0
    ? Math.min(Math.max(displayIndex, 0), displays.length - 1)
    : 0
  const display = displays[idx] || screen.getPrimaryDisplay()
  return {
    id: display.id,
    scaleFactor: display.scaleFactor,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    size: {
      width: display.size.width,
      height: display.size.height,
    },
  }
}

export function initCapture(): void {
  if (!screen || typeof screen.getPrimaryDisplay !== 'function') {
    throw new Error('Electron screen module unavailable in main process')
  }
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    throw new Error('Electron desktopCapturer unavailable in main process')
  }
}
