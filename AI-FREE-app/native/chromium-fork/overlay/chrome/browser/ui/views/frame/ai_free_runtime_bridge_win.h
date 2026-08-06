// Copyright 2026 AI-FREE Authors. All rights reserved.

#ifndef CHROME_BROWSER_UI_VIEWS_FRAME_AI_FREE_RUNTIME_BRIDGE_WIN_H_
#define CHROME_BROWSER_UI_VIEWS_FRAME_AI_FREE_RUNTIME_BRIDGE_WIN_H_

#include <cstdint>

class Browser;

// Starts the authenticated AI-FREE Runtime Bridge for the first top-level
// browser HWND. The Native Browser Host remains the only component that calls
// SetParent. Chromium owns navigation and Profile session mutations on the UI
// thread while the pipe reader and heartbeat writer run independently.
void MaybeStartAiFreeRuntimeBridge(uintptr_t browser_hwnd, Browser* browser);

#endif  // CHROME_BROWSER_UI_VIEWS_FRAME_AI_FREE_RUNTIME_BRIDGE_WIN_H_
