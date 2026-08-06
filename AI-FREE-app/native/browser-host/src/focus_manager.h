#pragma once

#include <windows.h>
#include <node_api.h>

// Transfers keyboard focus to an embedded Chromium browser while the owning
// Electron window is already in the foreground. Callers use this only for
// explicit focus requests; ordinary browser clicks follow native activation.
bool FocusBrowserChildWindow(HWND child);
bool ReleaseBrowserChildWindowFocus(HWND child);

napi_value FocusChildWindow(napi_env env, napi_callback_info info);
napi_value ReleaseChildWindowFocus(napi_env env, napi_callback_info info);
