{
  "targets": [
    {
      "target_name": "browser_host",
      "sources": [
        "src/addon.cc",
        "src/browser_host_window.cc",
        "src/child_window_manager.cc",
        "src/dpi_manager.cc",
        "src/focus_manager.cc",
        "src/process_monitor.cc",
        "src/win_delay_load_hook.cc"
      ],
      "defines": ["NAPI_VERSION=9", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["delayimp.lib", "user32.lib", "gdi32.lib", "dwmapi.lib"],
          "msvs_settings": {
            "VCLinkerTool": {
              "DelayLoadDLLs": ["node.exe"]
            },
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0,
              "AdditionalOptions": ["/std:c++17", "/utf-8"]
            }
          }
        }]
      ]
    },
    {
      "target_name": "dpi_scaling_test",
      "type": "executable",
      "sources": ["test/dpi_scaling_test.cc"],
      "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["user32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0,
              "AdditionalOptions": ["/std:c++17", "/utf-8"]
            }
          }
        }]
      ]
    }
  ]
}
