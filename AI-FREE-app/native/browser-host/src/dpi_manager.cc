#include "native_helpers.h"

napi_value SetPerMonitorDpiAwareness(napi_env env, napi_callback_info) {
  using SetDpiAwarenessContext = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  auto set_context = reinterpret_cast<SetDpiAwarenessContext>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
  if (!set_context) return BoolValue(env, false);
  BOOL ok = set_context(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (!ok && GetLastError() == ERROR_ACCESS_DENIED) return BoolValue(env, true);
  return BoolValue(env, ok != FALSE);
}
