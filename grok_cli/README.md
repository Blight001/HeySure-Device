# grok_cli — 本地 OpenAI 兼容 API 网关

把本机 **grok CLI**（订阅额度）包装成一个标准的 OpenAI 格式 HTTP 服务。任何按
OpenAI 协议调用的客户端都能直接使用，HeySure 服务器把它当成普通 API 模型预设即可，
服务端不再需要任何 CLI 特判逻辑。

```
HeySure AI Runtime ──HTTP──► grok-cli-gateway (127.0.0.1:8100) ──subprocess──► grok.exe
```

## 启动

纯 Python 标准库实现，无第三方依赖：

```bat
device\grok_cli\run.bat
:: 或
python server.py --command C:\Users\admin\.grok\bin\grok.exe --port 8100
```

| 环境变量 / 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `GROK_CLI_COMMAND` / `--command` | `grok` | grok CLI 命令名或完整路径（run.bat 默认 `%USERPROFILE%\.grok\bin\grok.exe`） |
| `GROK_CLI_HOST` / `--host` | `127.0.0.1` | 监听地址 |
| `GROK_CLI_PORT` / `--port` | `8100` | 监听端口 |
| `GROK_CLI_TIMEOUT` / `--timeout` | `600` | 单次推理超时（秒），超时杀进程 |
| `GROK_CLI_API_KEY` / `--api-key` | 空（不校验） | 设置后要求请求携带 `Authorization: Bearer <key>` |
| `GROK_CLI_MODELS` / `--models` | `grok-4.5` | `GET /v1/models` 展示的模型 id（逗号分隔，仅展示用） |

## 接口

- `POST /v1/chat/completions` — OpenAI 格式，支持 `stream: true`（SSE）与非流式。
  - `model` 原样透传给 CLI 的 `-m`。
  - 推理增量以 `delta.reasoning_content` 输出，正文以 `delta.content` 输出。
  - 消息里的图片块（`image_url` data URL / http(s) / 本地路径）会落盘到 `runtime/`
    临时文件，并提示模型用 grok 内置 `read_file` 查看像素。
- `GET /v1/models` — 展示配置的模型列表。
- `GET /` — 健康检查。

## 在 HeySure 中使用

系统设置 → 模型预设，新增一条普通 API 预设：

- **Base URL**：`http://127.0.0.1:8100/v1/chat/completions`
- **API Key**：任意非空值（除非配置了 `GROK_CLI_API_KEY`）
- **模型**：如 `grok-4.5`（透传给 `grok -m`）

> 网关必须与 grok CLI 在同一台机器上运行；HeySure 服务器只需能通过 HTTP 访问该
> 端口（本机部署填 127.0.0.1；服务器在别处时用 `--host 0.0.0.0` 并配置 `--api-key`）。

## 实现要点（grok CLI 的坑）

- 每次请求启动一个 CLI 进程：`grok --prompt-file <tmp> --output-format streaming-json ...`，
  完整对话（含 system prompt）序列化进 prompt 文件，无状态。
- grok 拒绝创建零内置工具的会话，最少保留 `--tools todo_write,read_file`
  （`read_file` 同时用于图片输入）；`--tools ""` 与 `--disallowed-tools "*"` 均不生效。
- prompt 不支持 stdin，必须用 `--prompt-file`。
- `--max-turns` 会把 thinking 也算一轮，不要使用。
