#pragma once

#include <node_api.h>

napi_value AttachChildWindow(napi_env env, napi_callback_info info);
napi_value DetachChildWindow(napi_env env, napi_callback_info info);
napi_value FindMainWindowByProcessId(napi_env env, napi_callback_info info);
napi_value SetChildWindowTitle(napi_env env, napi_callback_info info);
napi_value IsChildWindowAttached(napi_env env, napi_callback_info info);
