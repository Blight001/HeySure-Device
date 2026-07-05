// The device has no built-in native MCP tools of its own. Everything it can
// run — keyboard / mouse / screen / window / … and even shell.run — is a
// dynamic MCP tool the server pushes down (device:tool-config) and executor
// /dynamic.ts applies. See 设备端MCP代码下放长期方案 阶段三/四 and device/read.md
// for the static toolDefs vs. server-pushed dynamic MCP boundary.
