# Codex Pocket 第四阶段契约：多协议 Provider 适配层

本机 codex 只会说 Responses；所以**由本机兼容代理去适配各家的真实协议**。渠道的 `wire`
就是“这家供应商说哪种话”。用户要求至少覆盖：OpenAI 通用（chat）、OpenAI Responses、
Gemini 通用、Anthropic 通用，以及通用 Chat API / 本地 Ollama。

## A. wire 取值与鉴权

| wire | 上游端点 | 鉴权 | 模型清单 |
|---|---|---|---|
| `openai-chat` | `POST {base}/chat/completions` | `Authorization: Bearer <key>` | `GET {base}/models` → `data[].id` |
| `openai-responses` | `POST {base}/responses`（直连，不走代理） | `Authorization: Bearer <key>` | `GET {base}/models` |
| `anthropic` | `POST {base}/messages` | `x-api-key: <key>`、`anthropic-version: 2023-06-01` | `GET {base}/models` → `data[].id`（失败不致命） |
| `gemini` | `POST {base}/models/{model}:streamGenerateContent?alt=sse`（非流式 `:generateContent`） | `x-goog-api-key: <key>` | `GET {base}/models` → `models[].name`，去掉 `models/` 前缀 |
| `azure-openai` | `POST {base}/openai/deployments/{model}/chat/completions?api-version=2024-10-21` | `api-key: <key>` | `GET {base}/openai/models?api-version=2024-10-21` |
| `ollama` | `POST {base}/api/chat` | 无 | `GET {base}/api/tags` → `models[].name` |

- 兼容旧值：`chat` → `openai-chat`，`responses` → `openai-responses`（读渠道文件时归一化，写入时用新值）。
- `base` 已经包含版本段（如 `/v1`、`/v1beta`），代理**不要重复拼** `/v1`；只能在其后接上表里的相对路径。
- 所有请求 30s 连接 / 120s 无数据超时；响应体截断上限 1 MiB（模型清单）/ 2 MiB（对话非流式）。

## B. 代理转换（Responses ⇄ 上游）

对外始终是 `POST /v1/<channelId>/responses`（SSE）。内部按 wire 选适配器：

**openai-chat / azure-openai / ollama**
- 请求：`instructions`→system、`input[]`→messages、`tools`→function 形状、`tool_choice` 映射、
  `max_output_tokens`→`max_tokens`（ollama 为 `options.num_predict`）、`stream:true`。
- 流式：`delta.content`→`output_text.delta`；`delta.reasoning_content|reasoning`→`reasoning_summary_text.delta`；
  `delta.tool_calls[]`→`function_call_arguments.delta`；`[DONE]`/EOF→`output_item.done`+`response.completed`。
- ollama：NDJSON（每行一个 JSON），`message.content`→text、`message.thinking`→reasoning；`done:true` 结束。
- azure：路径按上表替换，其余同 openai-chat。

**anthropic**
- 请求：system 用顶层 `system`；messages 里 user/assistant；图片 `source.base64`；
  tools → `{name,description,input_schema}`；`max_output_tokens`→`max_tokens`（必填，缺省 4096）；
  `tool_choice`→`{type:'auto'|'any'|'tool',name?}`；`stream:true`。
- 流式事件映射：`message_start`→`response.created`；`content_block_start`(text|thinking|tool_use)→
  `output_item.added`；`content_block_delta.text_delta`→`output_text.delta`；
  `content_block_delta.thinking_delta`→`reasoning_summary_text.delta`；
  `content_block_delta.input_json_delta`→`function_call_arguments.delta`；
  `content_block_stop`→`output_item.done`；`message_delta.usage`→`response.completed.usage`；
  `message_stop`→`response.completed`。`error` 事件→HTTP 透传 + `upstream_error`。

**gemini**
- 请求：`contents:[{role:'user'|'model',parts:[{text}|{functionCall}|{functionResponse}]}]`；
  system → `systemInstruction.parts[].text`；tools → `[{functionDeclarations:[...]}]`；
  `generationConfig:{maxOutputTokens, temperature, topP}`；流式 `:streamGenerateContent?alt=sse`。
- 流式：`candidates[].content.parts[].text`→`output_text.delta`；
  `parts[].thought===true` 的 text→`reasoning_summary_text.delta`；
  `parts[].functionCall`→`output_item.added(function_call)` + `function_call_arguments.delta`（JSON 序列化）；
  `usageMetadata`→`response.completed.usage`。
- 非流式 `:generateContent` 也要支持（合成完整事件序列）。

## C. 模型清单与探测

- `POST /api/channels/models` 按 wire 走对应清单接口；解析成 `{models:[{id}]}`；
  拉取失败**不要**致命：返回 502 + 原文，UI 可重试。
- `POST /api/channels/test`（新增）`{id}`：完整探活 → `{ok,wire,models:number,latencyMs}`；
  200 成功 / 502 失败带 `details.stage`（`connect`|`auth`|`list`|`infer`）。
  其中 `infer` 用一次极小的非流式请求（`max_tokens:1`，prompt `"ping"`）验证密钥真的能用。

## D. 界面

- 渠道表单的“协议”从 2 个变成下拉：`OpenAI 兼容（chat）`、`OpenAI Responses`、
  `Anthropic`、`Gemini`、`Azure OpenAI`、`Ollama 本地`（显示对应 wire 值）。
- 每个 wire 给出该填的 Base URL 例子（如 Gemini `https://generativelanguage.googleapis.com/v1beta`）。
- 渠道列表徽标显示 wire；`新增/编辑` 时带“测试连接”按钮调用 `/api/channels/test`，
  显示 `ok / 失败阶段 / 模型数 / 延迟`。
- 模型池按渠道 wire 显示的模型清单不变（仍来自 `/api/channels/models`）。

## E. 测试要求

- 每个 wire 一个本地假上游（真实 HTTP 服务器），断言：
  请求体字段正确（含鉴权头/路径/参数）、SSE 事件序列与 delta 合并正确、错误透传。
- `channels/test` 覆盖成功与 `connect/auth/list/infer` 四种失败阶段。
- 现有 `channels.test.mjs`（15）与 `bridge-contract`（39）、toolpacks（16）必须继续全绿。
