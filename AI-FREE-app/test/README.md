# 分层测试目录

方案 §4.5 约定的结构。迁移规则：旧扁平 test/*.test.js 中的有效场景
重写为行为测试放入对应层后删除原文件；纯源码文本断言直接废弃。

- unit/ 纯单元（domain 规则、schema、转换）
- contract/ IPC/HTTP/存储契约
- integration/ main/renderer/electron/chromium/browser-automation 集成
- packaging/ 打包产物校验
- acceptance/ 真实环境验收定义
- fixtures/ 脱敏最小数据
- helpers/ 测试基础设施（不得含业务断言）
