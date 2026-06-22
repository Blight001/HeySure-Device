import { getRobot } from './robot'
import { store } from '../../store'

let lastCaptureSize: { width: number; height: number } | null = null
let lastCaptureGeometry: CaptureGeometry | null = null

export interface CaptureGeometry {
  capture: { width: number; height: number }
  display: {
    id: number
    scaleFactor: number
    bounds: { x: number; y: number; width: number; height: number }
    size: { width: number; height: number }
  }
}

function envNumber(name: string, fallback = 0): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) ? n : fallback
}

function settingNumber(name: string, fallback: number): number {
  const n = Number((store.store as any)[name])
  return Number.isFinite(n) ? n : fallback
}

export function rememberCaptureGeometry(geometry: CaptureGeometry): void {
  const width = Number(geometry?.capture?.width)
  const height = Number(geometry?.capture?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  lastCaptureSize = { width, height }
  lastCaptureGeometry = geometry
}

export function getCoordinateCalibration() {
  const captureSize = lastCaptureSize
  let robotSize: { width: number; height: number }
  try {
    robotSize = getRobot().getScreenSize()
  } catch (_) {
    robotSize = { width: 0, height: 0 }
  }
  if (!captureSize || !robotSize?.width || !robotSize?.height) {
    return {
      capture: captureSize,
      robot: robotSize,
      display: lastCaptureGeometry?.display || null,
      frame: null,
      scale_x: 1,
      scale_y: 1,
    }
  }
  const frame = calibratedFrame(robotSize, captureSize)
  return {
    capture: captureSize,
    robot: robotSize,
    display: lastCaptureGeometry?.display || null,
    frame,
    scale_x: Number(frame.width) / Number(captureSize.width),
    scale_y: Number(frame.height) / Number(captureSize.height),
  }
}

function almostSameSize(
  a: { width: number; height: number },
  b: { width: number; height: number },
  tolerance = 0.04,
): boolean {
  if (!a.width || !a.height || !b.width || !b.height) return false
  const dx = Math.abs(Number(a.width) - Number(b.width)) / Math.max(Number(a.width), Number(b.width))
  const dy = Math.abs(Number(a.height) - Number(b.height)) / Math.max(Number(a.height), Number(b.height))
  return dx <= tolerance && dy <= tolerance
}

function calibratedFrame(
  robotSize: { width: number; height: number },
  captureSize: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const geometry = lastCaptureGeometry
  if (!geometry) return { x: 0, y: 0, width: robotSize.width, height: robotSize.height }

  const bounds = geometry.display.bounds
  const scaleFactor = Number(geometry.display.scaleFactor || 1)
  const nativeSize = {
    width: Math.round(Number(bounds.width) * scaleFactor),
    height: Math.round(Number(bounds.height) * scaleFactor),
  }
  const nativeFrame = {
    x: Math.round(Number(bounds.x) * scaleFactor),
    y: Math.round(Number(bounds.y) * scaleFactor),
    width: nativeSize.width,
    height: nativeSize.height,
  }

  if (almostSameSize(robotSize, bounds)) return bounds
  if (almostSameSize(robotSize, nativeSize)) return nativeFrame
  if (almostSameSize(robotSize, captureSize)) {
    return { x: 0, y: 0, width: robotSize.width, height: robotSize.height }
  }

  const robotLooksLikeVirtualDesktop = robotSize.width > bounds.width || robotSize.height > bounds.height
  if (robotLooksLikeVirtualDesktop && almostSameSize(captureSize, bounds, 0.08)) return bounds
  if (robotLooksLikeVirtualDesktop && almostSameSize(captureSize, nativeSize, 0.08)) return bounds

  // On Windows with DPI virtualization, robotjs often works in Electron's DIP
  // coordinates while desktopCapturer returns native screenshot pixels.
  if (scaleFactor !== 1 && almostSameSize(captureSize, nativeSize, 0.08)) return bounds

  return { x: 0, y: 0, width: robotSize.width, height: robotSize.height }
}

export function toRobotPoint(x: number, y: number): { x: number; y: number } {
  const robotSize = getRobot().getScreenSize()
  const captureSize = lastCaptureSize
  const scaleSettingX = settingNumber('mouseCoordinateScaleX', envNumber('HEYSURE_MOUSE_SCALE_X', 1))
  const scaleSettingY = settingNumber('mouseCoordinateScaleY', envNumber('HEYSURE_MOUSE_SCALE_Y', 1))
  const offsetSettingX = settingNumber('mouseCoordinateOffsetX', envNumber('HEYSURE_MOUSE_X_OFFSET'))
  const offsetSettingY = settingNumber('mouseCoordinateOffsetY', envNumber('HEYSURE_MOUSE_Y_OFFSET'))
  const adjustedX = x * scaleSettingX + offsetSettingX
  const adjustedY = y * scaleSettingY + offsetSettingY
  if (!captureSize || !robotSize?.width || !robotSize?.height) {
    return { x: Math.round(adjustedX), y: Math.round(adjustedY) }
  }

  const frame = calibratedFrame(robotSize, captureSize)
  const scaleX = Number(frame.width) / Number(captureSize.width)
  const scaleY = Number(frame.height) / Number(captureSize.height)
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return { x: Math.round(adjustedX), y: Math.round(adjustedY) }
  }

  return {
    x: Math.round(Number(frame.x || 0) + adjustedX * scaleX),
    y: Math.round(Number(frame.y || 0) + adjustedY * scaleY),
  }
}
