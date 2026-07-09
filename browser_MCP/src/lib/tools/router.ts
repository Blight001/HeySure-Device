// tools/router.ts — public tool dispatcher.
// Routes browser_* names to executeBrowserOnly. This is what background code
// and the AI loop call. (Card automation was removed.)

import { executeBrowserOnly } from './browser'
import { executeDynamicMcp } from './dynamic'

export async function executeBrowserTool(name: string, args: any): Promise<any> {
  const dynamic = await executeDynamicMcp(name, args || {}, executeBrowserTool, executeBrowserOnly)
  if (dynamic.handled) return dynamic.result
  return executeBrowserOnly(name, args)
}
