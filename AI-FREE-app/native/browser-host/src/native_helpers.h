#pragma once

#include <node_api.h>
#include <windows.h>
#include <stdint.h>
#include <string>

inline void ThrowLastError(napi_env env, const char* operation) {
  DWORD code = GetLastError();
  char buffer[160];
  sprintf_s(buffer, "%s failed (Win32 error %lu)", operation, static_cast<unsigned long>(code));
  napi_throw_error(env, nullptr, buffer);
}

inline napi_value GetNamed(napi_env env, napi_value object, const char* name) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return nullptr;
  return value;
}

inline uint64_t ReadUint64(napi_env env, napi_value value) {
  if (!value) return 0;
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type == napi_bigint) {
    uint64_t result = 0;
    bool lossless = false;
    napi_get_value_bigint_uint64(env, value, &result, &lossless);
    return result;
  }
  if (type == napi_number) {
    double result = 0;
    napi_get_value_double(env, value, &result);
    return static_cast<uint64_t>(result);
  }
  if (type == napi_string) {
    size_t length = 0;
    napi_get_value_string_utf8(env, value, nullptr, 0, &length);
    std::string text(length + 1, '\0');
    napi_get_value_string_utf8(env, value, text.data(), text.size(), &length);
    return _strtoui64(text.c_str(), nullptr, 10);
  }
  if (type == napi_object) {
    bool is_buffer = false;
    napi_is_buffer(env, value, &is_buffer);
    if (is_buffer) {
      void* data = nullptr;
      size_t length = 0;
      napi_get_buffer_info(env, value, &data, &length);
      uint64_t result = 0;
      if (data && length >= sizeof(void*)) memcpy(&result, data, sizeof(void*));
      return result;
    }
  }
  return 0;
}

inline HWND ReadHwnd(napi_env env, napi_value value) {
  return reinterpret_cast<HWND>(static_cast<uintptr_t>(ReadUint64(env, value)));
}

inline std::wstring ReadWideString(napi_env env, napi_value value, const wchar_t* fallback = L"") {
  if (!value) return fallback;
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return fallback;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return fallback;
  std::u16string text(length + 1, u'\0');
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, value, reinterpret_cast<char16_t*>(text.data()), text.size(), &copied) != napi_ok) {
    return fallback;
  }
  return std::wstring(reinterpret_cast<const wchar_t*>(text.data()), copied);
}

inline int32_t ReadInt32(napi_env env, napi_value object, const char* name, int32_t fallback = 0) {
  napi_value value = GetNamed(env, object, name);
  if (!value) return fallback;
  int32_t result = fallback;
  napi_get_value_int32(env, value, &result);
  return result;
}

inline napi_value HwndValue(napi_env env, HWND hwnd) {
  std::string text = std::to_string(static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(hwnd)));
  napi_value result;
  napi_create_string_utf8(env, text.c_str(), text.size(), &result);
  return result;
}

inline napi_value BoolValue(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

inline napi_value SingleObjectArg(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "Expected an options object");
    return nullptr;
  }
  return args[0];
}
