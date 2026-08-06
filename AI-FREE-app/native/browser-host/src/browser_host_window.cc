#include "browser_host_window.h"
#include "dpi_manager.h"
#include "native_helpers.h"

namespace {
const wchar_t* kHostWindowClass = L"AIFreeBrowserHostWindow";

void ResizeHostedChild(HWND hwnd) {
  HWND child = GetWindow(hwnd, GW_CHILD);
  if (!IsWindow(child)) return;
  RECT rect = {};
  GetClientRect(hwnd, &rect);
  const int width = rect.right > rect.left ? rect.right - rect.left : 0;
  const int height = rect.bottom > rect.top ? rect.bottom - rect.top : 0;
  SetWindowPos(child, HWND_TOP, 0, 0,
      width, height,
      SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

LRESULT CALLBACK HostWindowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_ERASEBKGND: {
      RECT rect;
      GetClientRect(hwnd, &rect);
      FillRect(reinterpret_cast<HDC>(wparam), &rect, reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
      return 1;
    }
    case WM_SIZE: {
      ResizeHostedChild(hwnd);
      return 0;
    }
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

bool EnsureHostClass() {
  static bool registered = false;
  if (registered) return true;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = HostWindowProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  wc.lpszClassName = kHostWindowClass;
  registered = RegisterClassExW(&wc) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
  return registered;
}

struct PhysicalBounds {
  int x;
  int y;
  int width;
  int height;
};

PhysicalBounds ReadPhysicalBounds(napi_env env, napi_value options, HWND parent) {
  const UINT dpi = GetWindowDpiOrDefault(parent);
  return {
    DipToPhysicalPixel(ReadInt32(env, options, "x"), dpi),
    DipToPhysicalPixel(ReadInt32(env, options, "y"), dpi),
    DipToPhysicalPixel(ReadInt32(env, options, "width"), dpi),
    DipToPhysicalPixel(ReadInt32(env, options, "height"), dpi),
  };
}
}

napi_value CreateHostWindow(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  if (!options) return nullptr;
  HWND parent = ReadHwnd(env, GetNamed(env, options, "parentHwnd"));
  if (!IsWindow(parent)) {
    napi_throw_error(env, nullptr, "parentHwnd is not a live window");
    return nullptr;
  }
  if (!EnsureHostClass()) {
    ThrowLastError(env, "RegisterClassExW");
    return nullptr;
  }
  // Electron layout APIs use device-independent pixels. This native child is
  // positioned by a Per-Monitor-DPI-aware Win32 thread, where coordinates are
  // physical pixels. Convert against the owner window so mixed-DPI monitors do
  // not shrink or offset the embedded Chromium surface.
  const PhysicalBounds bounds = ReadPhysicalBounds(env, options, parent);
  HWND hwnd = CreateWindowExW(
      WS_EX_NOPARENTNOTIFY,
      kHostWindowClass,
      L"AI-FREE",
      // Keep the black host hidden until Chromium is attached and has been
      // synchronously sized. This avoids exposing an empty black rectangle
      // during the runtime handshake.
      WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
      bounds.x, bounds.y, bounds.width, bounds.height,
      parent, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) {
    ThrowLastError(env, "CreateWindowExW");
    return nullptr;
  }
  return HwndValue(env, hwnd);
}

napi_value DestroyHostWindow(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND hwnd = ReadHwnd(env, GetNamed(env, options, "hostHwnd"));
  return BoolValue(env, !IsWindow(hwnd) || DestroyWindow(hwnd) != FALSE);
}

napi_value SetHostBounds(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND hwnd = ReadHwnd(env, GetNamed(env, options, "hostHwnd"));
  if (!IsWindow(hwnd)) return BoolValue(env, false);
  HWND parent = GetParent(hwnd);
  const PhysicalBounds bounds = ReadPhysicalBounds(
      env, options, IsWindow(parent) ? parent : hwnd);
  // Electron's renderer owns a sibling Chrome_RenderWidgetHostHWND that spans
  // the whole client area. Keeping SWP_NOZORDER here leaves this native host
  // behind that renderer, so the attached Chromium window is alive but the
  // user only sees Electron's black background. Raise the host whenever its
  // bounds are synchronized.
  const bool visible = IsWindowVisible(hwnd) != FALSE;
  bool ok = SetWindowPos(hwnd, visible ? HWND_TOP : nullptr,
      bounds.x, bounds.y, bounds.width, bounds.height,
      SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_NOZORDER)) != FALSE;
  return BoolValue(env, ok);
}

napi_value RaiseHostWindow(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND hwnd = ReadHwnd(env, GetNamed(env, options, "hostHwnd"));
  if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return BoolValue(env, false);
  return BoolValue(env, SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) != FALSE);
}

static napi_value SetHostVisibility(napi_env env, napi_callback_info info, int command) {
  napi_value options = SingleObjectArg(env, info);
  HWND hwnd = ReadHwnd(env, GetNamed(env, options, "hostHwnd"));
  if (!IsWindow(hwnd)) return BoolValue(env, false);
  ShowWindow(hwnd, command);
  return BoolValue(env, true);
}

napi_value ShowHostWindow(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  HWND hwnd = ReadHwnd(env, GetNamed(env, options, "hostHwnd"));
  if (!IsWindow(hwnd)) return BoolValue(env, false);
  const bool was_visible = IsWindowVisible(hwnd) != FALSE;
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  const bool ok = SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW) != FALSE;
  // Only force a paint for a real hidden -> visible transition. Re-focusing
  // the Electron owner calls this method as a lightweight Z-order repair and
  // must not invalidate every Chromium child window again.
  if (ok && !was_visible) {
    ResizeHostedChild(hwnd);
    RedrawWindow(hwnd, nullptr, nullptr,
        RDW_INVALIDATE | RDW_ALLCHILDREN);
  }
  return BoolValue(env, ok);
}
napi_value HideHostWindow(napi_env env, napi_callback_info info) { return SetHostVisibility(env, info, SW_HIDE); }
