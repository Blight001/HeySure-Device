#include "focus_manager.h"
#include "native_helpers.h"

namespace {

bool IsFocusedWindowOrDescendant(HWND child) {
  const DWORD target_thread = GetWindowThreadProcessId(child, nullptr);
  if (!target_thread) return false;
  GUITHREADINFO info = {};
  info.cbSize = sizeof(info);
  return GetGUIThreadInfo(target_thread, &info) != FALSE &&
      (info.hwndFocus == child ||
       (info.hwndFocus && IsChild(child, info.hwndFocus)));
}

}  // namespace

bool FocusBrowserChildWindow(HWND child) {
  if (!IsWindow(child)) return false;
  // Focus the Aura browser window, not Chrome_RenderWidgetHostHWND directly.
  // Aura must own the focus transition so it can synchronize its internal
  // FocusManager before forwarding keyboard events to Blink.
  HWND target = child;

  HWND root = GetAncestor(child, GA_ROOT);
  if (!root || !IsWindowVisible(root)) return false;

  // A focus request for an embedded browser must never activate AI-FREE from
  // the background. Besides stealing input from other applications, calling
  // SetForegroundWindow here also makes automatic show/tab-layout work look
  // like a user focus action. Only transfer focus while the Electron owner is
  // already the foreground window.
  HWND foreground = GetForegroundWindow();
  if (foreground != root) return false;

  const DWORD target_thread =
      GetWindowThreadProcessId(target, nullptr);
  const DWORD current_thread = GetCurrentThreadId();
  const DWORD foreground_thread = foreground
      ? GetWindowThreadProcessId(foreground, nullptr)
      : 0;

  const bool attached_target = target_thread != 0 &&
      target_thread != current_thread &&
      AttachThreadInput(current_thread, target_thread, TRUE) != FALSE;
  const bool attached_foreground = foreground_thread != 0 &&
      foreground_thread != current_thread &&
      foreground_thread != target_thread &&
      AttachThreadInput(current_thread, foreground_thread, TRUE) != FALSE;

  SetFocus(target);

  const bool focused = IsFocusedWindowOrDescendant(child);

  if (attached_foreground) {
    AttachThreadInput(current_thread, foreground_thread, FALSE);
  }
  if (attached_target) {
    AttachThreadInput(current_thread, target_thread, FALSE);
  }
  return focused;
}

bool ReleaseBrowserChildWindowFocus(HWND child) {
  if (!IsWindow(child)) return false;
  HWND root = GetAncestor(child, GA_ROOT);
  if (!root || GetForegroundWindow() != root) return false;
  if (!IsFocusedWindowOrDescendant(child)) return true;

  const DWORD child_thread = GetWindowThreadProcessId(child, nullptr);
  const DWORD root_thread = GetWindowThreadProcessId(root, nullptr);
  const DWORD current_thread = GetCurrentThreadId();
  const bool attached_child = child_thread != 0 &&
      child_thread != current_thread &&
      AttachThreadInput(current_thread, child_thread, TRUE) != FALSE;
  const bool attached_root = root_thread != 0 &&
      root_thread != current_thread &&
      root_thread != child_thread &&
      AttachThreadInput(current_thread, root_thread, TRUE) != FALSE;

  SetFocus(root);
  const bool released = !IsFocusedWindowOrDescendant(child);

  if (attached_root) {
    AttachThreadInput(current_thread, root_thread, FALSE);
  }
  if (attached_child) {
    AttachThreadInput(current_thread, child_thread, FALSE);
  }
  return released;
}

napi_value FocusChildWindow(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND child = ReadHwnd(env, GetNamed(env, options, "childHwnd"));
  if (!IsWindow(child)) return BoolValue(env, false);
  ShowWindow(child, SW_SHOW);
  return BoolValue(env, FocusBrowserChildWindow(child));
}

napi_value ReleaseChildWindowFocus(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND child = ReadHwnd(env, GetNamed(env, options, "childHwnd"));
  return BoolValue(env, ReleaseBrowserChildWindowFocus(child));
}
