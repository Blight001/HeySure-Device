#include "native_helpers.h"

napi_value IsWindowAlive(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  napi_value value = GetNamed(env, options, "hwnd");
  if (!value) value = GetNamed(env, options, "childHwnd");
  return BoolValue(env, IsWindow(ReadHwnd(env, value)) != FALSE);
}

napi_value GetWindowProcessId(napi_env env, napi_callback_info info) {
  napi_value options = SingleObjectArg(env, info);
  napi_value value = GetNamed(env, options, "hwnd");
  if (!value) value = GetNamed(env, options, "childHwnd");
  HWND hwnd = ReadHwnd(env, value);
  DWORD pid = 0;
  if (IsWindow(hwnd)) GetWindowThreadProcessId(hwnd, &pid);
  napi_value result;
  napi_create_uint32(env, pid, &result);
  return result;
}
