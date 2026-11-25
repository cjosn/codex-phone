# Codex Pocket 第三阶段契约：本机引擎的兼容通道 + 多渠道 + 本机/远程

背景（已核实）：
- 引擎确实在手机上跑（PRoot Ubuntu → node bridge → codex 0.170 二进制），不依赖官方云。
- codex 0.170 二进制只实现了 **Responses API**（`/responses`），没有 `/chat/completions`。
  国内中转站大多只有 `chat/completions`，所以「OpenAI 兼容接不进来」是协议形状问题。
- 之前 401 是密钥问题（保存被 busy 拒绝时密钥被清空，已修）。

## A. 兼容代理（bridge → 中转站）

新增模块 `codex-go/bridge/compat-proxy.mjs`，由 server.mjs 在启动时拉起，**只监听 127.0.0.1**，端口由系统分配。

- 路由：`POST /v1/<channelId>/responses`（SSE）。
- 上游：`POST <channel.baseUrl>/chat/completions`，`Authorization: Bearer <key>`，`stream: true`。
- 请求转换：Responses `input[]`（message content parts）→ chat `messages[]`；
  `instructions` → system message；`tools`（Responses 形状）→ chat `tools`（function 形状），
  `tool_choice` 直传映射；`max_output_tokens` → `max_tokens`；`reasoning.effort` 丢弃（上游多不支持）。
- 流式转换：上游 `delta.content` → `response.output_text.delta`；
  `delta.reasoning_content` 或 `delta.reasoning` → `response.reasoning_summary_text.delta`（思考链）；
  `delta.tool_calls[]` → `response.output_item.added` + `response.function_call_arguments.delta`；
  结束时发 `response.output_item.done` + `response.completed`，带 `usage`（有则透传）。
- 非流式上游（无 `stream` 能力）时也要能工作：上游错误/普通 JSON → 合成完整的 Responses 事件序列。
- 上游非 2xx：返回 `{"error":{"type":"upstream_error","code":<status>,"message":"<body 前 300 字>"}}` 且 HTTP 状态透传，
  让 Codex 自己报错；不得伪造成功。
- 错误映射：连接失败 → 502；超时（默认 120s 无数据）→ 504。

## B. 渠道（可多个，可切换）

设置文件 `${CODEX_HOME}/codex-go-channels.json`：

```json
{"active":"relay-a","channels":[
  {"id":"relay-a","name":"中转 A","baseUrl":"https://relay-a.example/v1","wire":"chat","model":"deepseek-v4.1-flash","models":["deepseek-v4.1-flash"],"envKey":"CODEX_GO_CHANNEL_RELAY_A_KEY"},
  {"id":"official","name":"官方/Responses","baseUrl":"https://api.openai.com/v1","wire":"responses","model":"gpt-6.2-sol","models":[],"envKey":"CODEX_GO_CHANNEL_OFFICIAL_KEY"}
]}
```

- `wire`：`chat`（走本机兼容代理）或 `responses`（直连，路径同今天）。
- 密钥永不出现在任何 GET/列表响应里，只写 `${CODEX_HOME}/codex-go-secrets.json`。

接口（沿用 `/api/*` 鉴权 + POST）：

| 接口 | 请求 | 响应 |
|---|---|---|
| `POST /api/channels` | `{}` | `{active, channels:[{id,name,baseUrl,wire,model,models,apiKeyConfigured,active}]}` |
| `POST /api/channels/save` | `{id?,name,baseUrl,wire,model?,apiKey?}` | 同上单条渠道 + `{id}`；`id` 缺省按 name 生成 slug |
| `POST /api/channels/remove` | `{id}` | `{removed:true,id,active}`（删活动渠道则自动切到第一个） |
| `POST /api/channels/activate` | `{id}` | 同上 `{active,...}`；写 codex `config.toml` |
| `POST /api/channels/models` | `{id?}` 或 `{baseUrl,wire,apiKey?}` | `{models:[{id}]}`；`chat` 走 `<baseUrl>/models` 同样可拉 |

- `activate` 时写：`model_providers.<id> = {name,base_url,wire_api:"responses",env_key}`，
  `base_url`：`wire==='chat'` → `http://127.0.0.1:<proxyPort>/v1/<id>`；否则渠道自身 baseUrl；
  `model_provider=<id>`、`model=<channel.model>`。切换不允许在有活动回合时进行（沿用 409 + details.activeTurns）。
- 兼容代理按 `channelId` 找渠道配置；未知 id → 404 `channel/unknown`。

## C. 本机 / 远程

- 连接页新增模式开关：本机（用运行时下发的 baseUrl/token）或远程（手填 URL+token）。
- 选择持久化在 `SharedPreferences` 的 `codex.connectionMode`（`local`/`remote`），默认 `local`。
- 远程模式启动时不要自动拉起本机运行时；本机模式仍自动启动并等待就绪。
- 远程模式下 `subagent`/`workflow` 等走同一 bridge，不需要额外改造。

## D. 流式与思考链（UI 保障）

- 对话必须边收边渲染（不得等整段完成）：文本按 `text.delta` 追加，推理按 reasoning 事件进「思考中/思考链」折叠块。
- 每个 turn 结束才落到最终消息；`turn.end` 之前不得清空已渲染内容。
- 组件测试至少覆盖：连续 3 个 text.delta 后界面已有部分文本；reasoning 事件生成可展开的思考块。
