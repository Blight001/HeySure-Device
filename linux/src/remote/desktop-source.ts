// Resolve the primary screen as a desktopCapturer source the renderer can feed
// into getUserMedia({ chromeMediaSourceId }). Capture itself happens in the
// renderer (getUserMedia is renderer-only); main only hands over the id + size.

import { desktopCapturer, screen } from 'electron'

export interface PrimaryScreenSource {
  sourceId: string
  width: number
  height: number
}

export async function getPrimaryScreenSource(): Promise<PrimaryScreenSource> {
  const primary = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  })
  const match = sources.find(s => s.display_id === String(primary.id)) || sources[0]
  if (!match) throw new Error('没有可用的屏幕源（desktopCapturer 返回空）')
  return {
    sourceId: match.id,
    width: Math.round(primary.size.width),
    height: Math.round(primary.size.height),
  }
}
