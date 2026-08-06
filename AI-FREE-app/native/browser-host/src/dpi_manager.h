#pragma once

#include <windows.h>

inline UINT GetWindowDpiOrDefault(HWND hwnd) {
  using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  auto get_dpi = reinterpret_cast<GetDpiForWindowFn>(
      GetProcAddress(user32, "GetDpiForWindow"));
  const UINT dpi = get_dpi && IsWindow(hwnd) ? get_dpi(hwnd) : 0;
  return dpi ? dpi : USER_DEFAULT_SCREEN_DPI;
}

inline int DipToPhysicalPixel(int value, UINT dpi) {
  return MulDiv(value, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
}
