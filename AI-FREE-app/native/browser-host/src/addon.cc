#include <node_api.h>
#include "browser_host_window.h"
#include "child_window_manager.h"
#include "focus_manager.h"

napi_value SetPerMonitorDpiAwareness(napi_env env, napi_callback_info info);
napi_value IsWindowAlive(napi_env env, napi_callback_info info);
napi_value GetWindowProcessId(napi_env env, napi_callback_info info);

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"createHostWindow", nullptr, CreateHostWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"destroyHostWindow", nullptr, DestroyHostWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"attachChildWindow", nullptr, AttachChildWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"detachChildWindow", nullptr, DetachChildWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setHostBounds", nullptr, SetHostBounds, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"raiseHostWindow", nullptr, RaiseHostWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"showHostWindow", nullptr, ShowHostWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"hideHostWindow", nullptr, HideHostWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"focusChildWindow", nullptr, FocusChildWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseChildWindowFocus", nullptr, ReleaseChildWindowFocus, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isWindowAlive", nullptr, IsWindowAlive, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getWindowProcessId", nullptr, GetWindowProcessId, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"findMainWindowByProcessId", nullptr, FindMainWindowByProcessId, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setChildWindowTitle", nullptr, SetChildWindowTitle, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isChildWindowAttached", nullptr, IsChildWindowAttached, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setPerMonitorDpiAwareness", nullptr, SetPerMonitorDpiAwareness, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
