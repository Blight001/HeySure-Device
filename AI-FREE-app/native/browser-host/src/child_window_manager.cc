#include "child_window_manager.h"
#include "native_helpers.h"
#include <dwmapi.h>
#include <unordered_map>
#include <mutex>

namespace {
struct OriginalWindowState { HWND parent; LONG_PTR style; LONG_PTR ex_style; };
std::unordered_map<HWND, OriginalWindowState> original_states;
std::mutex states_mutex;

struct FindWindowContext { DWORD pid; HWND best; long long best_area; };

BOOL CALLBACK FindWindowCallback(HWND hwnd, LPARAM value) {
  auto* context = reinterpret_cast<FindWindowContext*>(value);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid != context->pid || GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
  RECT rect = {};
  GetWindowRect(hwnd, &rect);
  long long area = static_cast<long long>(rect.right - rect.left) * (rect.bottom - rect.top);
  if (area > context->best_area) { context->best = hwnd; context->best_area = area; }
  return TRUE;
}
}

napi_value AttachChildWindow(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND host = ReadHwnd(env, GetNamed(env, options, "hostHwnd"));
  HWND child = ReadHwnd(env, GetNamed(env, options, "childHwnd"));
  DWORD expected_pid = static_cast<DWORD>(ReadInt32(env, options, "childPid"));
  if (!IsWindow(host) || !IsWindow(child)) {
    napi_throw_error(env, nullptr, "hostHwnd or childHwnd is not a live window");
    return nullptr;
  }
  DWORD actual_pid = 0;
  GetWindowThreadProcessId(child, &actual_pid);
  if (!expected_pid || actual_pid != expected_pid) {
    napi_throw_error(env, nullptr, "child HWND does not belong to the expected Chromium PID");
    return nullptr;
  }
  DWORD current_session = 0, child_session = 0;
  ProcessIdToSessionId(GetCurrentProcessId(), &current_session);
  ProcessIdToSessionId(actual_pid, &child_session);
  if (current_session != child_session) {
    napi_throw_error(env, nullptr, "cross-session window embedding is forbidden");
    return nullptr;
  }
  LONG_PTR style = GetWindowLongPtr(child, GWL_STYLE);
  LONG_PTR ex_style = GetWindowLongPtr(child, GWL_EXSTYLE);
  {
    std::lock_guard<std::mutex> lock(states_mutex);
    if (!original_states.count(child)) original_states[child] = { GetParent(child), style, ex_style };
  }
  ShowWindow(child, SW_HIDE);
  const LONG_PTR embedded_style =
      (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU |
                 WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) |
      WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
  const LONG_PTR embedded_ex_style =
      ex_style & ~(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE |
                   WS_EX_DLGMODALFRAME);
  SetWindowLongPtr(child, GWL_STYLE, embedded_style);
  SetWindowLongPtr(child, GWL_EXSTYLE, embedded_ex_style);
  SetLastError(0);
  HWND previous = SetParent(child, host);
  if (!previous && GetLastError() != 0) {
    ThrowLastError(env, "SetParent");
    return nullptr;
  }
  if (GetParent(child) != host || !IsChild(host, child)) {
    napi_throw_error(env, nullptr, "Chromium HWND was not attached to the Browser Host");
    return nullptr;
  }
  const std::wstring product_title = ReadWideString(env, GetNamed(env, options, "title"), L"AI-FREE");
  if (!product_title.empty()) SetWindowTextW(child, product_title.c_str());
  RECT rect = {};
  GetClientRect(host, &rect);
  const int width = rect.right > rect.left ? rect.right - rect.left : 0;
  const int height = rect.bottom > rect.top ? rect.bottom - rect.top : 0;
  // The first attach must be synchronous. With SWP_ASYNCWINDOWPOS the host can
  // become visible before Chromium has processed its frame/bounds change,
  // leaving the user looking at the host's black background.
  bool ok = SetWindowPos(child, HWND_TOP, 0, 0,
      width, height,
      SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE) != FALSE;
  if (ok) {
    RedrawWindow(child, nullptr, nullptr,
        RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW);
    UpdateWindow(child);
    DwmFlush();
  }
  return BoolValue(env, ok);
}

napi_value SetChildWindowTitle(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND child = ReadHwnd(env, GetNamed(env, options, "childHwnd"));
  if (!IsWindow(child)) return BoolValue(env, false);
  const std::wstring title = ReadWideString(env, GetNamed(env, options, "title"), L"AI-FREE");
  return BoolValue(env, !title.empty() && SetWindowTextW(child, title.c_str()) != FALSE);
}

napi_value IsChildWindowAttached(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND host = ReadHwnd(env, GetNamed(env, options, "hostHwnd"));
  HWND child = ReadHwnd(env, GetNamed(env, options, "childHwnd"));
  return BoolValue(env, IsWindow(host) && IsWindow(child) && GetParent(child) == host && IsChild(host, child));
}

napi_value DetachChildWindow(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND child = ReadHwnd(env, GetNamed(env, options, "childHwnd"));
  if (!IsWindow(child)) return BoolValue(env, true);
  OriginalWindowState original = {};
  bool found = false;
  {
    std::lock_guard<std::mutex> lock(states_mutex);
    auto it = original_states.find(child);
    if (it != original_states.end()) { original = it->second; original_states.erase(it); found = true; }
  }
  ShowWindow(child, SW_HIDE);
  SetParent(child, found ? original.parent : nullptr);
  if (found) {
    SetWindowLongPtr(child, GWL_STYLE, original.style);
    SetWindowLongPtr(child, GWL_EXSTYLE, original.ex_style);
  }
  SetWindowPos(child, nullptr, 0, 0, 0, 0,
      SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  return BoolValue(env, true);
}

napi_value FindMainWindowByProcessId(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  DWORD pid = static_cast<DWORD>(ReadInt32(env, options, "pid"));
  FindWindowContext context = { pid, nullptr, -1 };
  EnumWindows(FindWindowCallback, reinterpret_cast<LPARAM>(&context));
  if (!context.best) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    return null_value;
  }
  return HwndValue(env, context.best);
}
