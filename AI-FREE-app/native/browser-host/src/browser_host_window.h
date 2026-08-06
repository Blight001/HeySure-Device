#pragma once

#include <node_api.h>

napi_value CreateHostWindow(napi_env env, napi_callback_info info);
napi_value DestroyHostWindow(napi_env env, napi_callback_info info);
napi_value SetHostBounds(napi_env env, napi_callback_info info);
napi_value RaiseHostWindow(napi_env env, napi_callback_info info);
napi_value ShowHostWindow(napi_env env, napi_callback_info info);
napi_value HideHostWindow(napi_env env, napi_callback_info info);
