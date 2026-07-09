// popup/markdown.ts — shared HTML-escaping helper.
// Chat/markdown rendering was removed along with the chat pane; the only piece
// still needed across the popup is `esc`, used wherever user/server strings are
// interpolated into innerHTML.

export function esc(s: string): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
