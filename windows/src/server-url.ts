export function normalizeServerUrl(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return value

  const url = new URL(value)
  if (url.hostname === 'localhost') {
    url.hostname = '127.0.0.1'
  }

  return url.href.replace(/\/$/, '')
}
