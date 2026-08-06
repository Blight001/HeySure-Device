// Redirect the delayed node.exe imports used by native Node addons to the
// current Electron executable. This is the Electron-compatible equivalent of
// node-gyp's win_delay_load_hook.cc with a fixed host binary name.
#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI LoadNodeExeHook(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary || !info || _stricmp(info->szDll, "node.exe") != 0) {
    return nullptr;
  }
  HMODULE module = GetModuleHandleW(L"libnode.dll");
  if (!module) module = GetModuleHandleW(nullptr);
  return reinterpret_cast<FARPROC>(module);
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = LoadNodeExeHook;
