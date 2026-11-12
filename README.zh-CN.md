---
locale: zh-CN
---

# Ollama Rerank

[English](README.md) | **简体中文**

通过自部署的 Ollama 提供 Jina/Cohere 风格的 `POST /v1/rerank` 接口，并按 Ollama 实际处理的 token 数计费。Ollama 本身没有重排序接口，插件用以下两种方式之一打分：

- 重排序模型 logprobs：对 Qwen3-Reranker 这类解码式重排序模型，每篇文档用官方 yes/no 提示词调用一次 `/api/generate`，分数为首个 token 的 `top_logprobs` 中 `P(yes) / (P(yes) + P(no))`。每篇文档一次上游请求。
- 向量余弦相似度：对 `qwen3-embedding:8b` 这类向量模型，一次 `/api/embed` 调用同时计算查询和全部文档的向量，分数为文档与查询的余弦相似度。

需要 new-api v1.0.0-rc.50 及以上版本（支持 Provider 插件）；重排序模型模式还需要 `/api/generate` 能返回 `logprobs` 的 Ollama 版本。

## 渠道设置

1. 安装插件后，新建类型为「任务插件」的渠道并绑定本插件。
2. Base URL：Ollama 的地址，不要带 `/v1`，例如 `http://127.0.0.1:11434` 或 Tailscale 内网地址。默认值为 `http://127.0.0.1:11434`。
3. 密钥：任意值。Ollama 不校验密钥，请用网络访问规则或带鉴权的反向代理保护服务。
4. 模型：填 Ollama 中的准确模型名，例如 `qwen3-embedding:8b`，或已拉取的 Qwen3-Reranker GGUF。需要对外显示其他名称时使用模型映射。
5. 渠道配置：
   - 打分方式：自动（默认）在模型名含 `rerank` 时使用重排序模型 logprobs，否则使用向量余弦相似度。模型名看不出类型时请手动指定。
   - 任务指令：传给 Qwen3 重排序模型和 Qwen3 向量查询的指令。
   - 上下文长度：每次请求的 Ollama `num_ctx`，0 表示使用服务端默认值。查询加文档超过模型默认长度时请调大，否则 Ollama 会截断提示词。

## 模型与接口

| 客户端接口 | 上游 | 说明 |
| --- | --- | --- |
| `POST /v1/rerank` | 每篇文档一次 `/api/generate`（重排序模型）或一次 `/api/embed`（向量模型） | 请求字段：`model`、`query`、`documents`（字符串或 `{text}` 对象）、`top_n`、`return_documents` |
| `GET /v1/models` | `/v1/models` | 渠道表单获取模型列表 |

## 计费

返回结果包含 `usage.total_tokens`，即本次调用中每个上游请求的 `prompt_eval_count` 与 `eval_count` 之和（包含命中缓存的提示词 token）。new-api 按模型价格把它作为输入 token 计费：

- 按 token 计费：为每个模型名设置模型倍率。倍率 1 表示每个 token 扣 1 额度，按默认额度换算为每百万 token 2 美元。
- 按次计费：改为设置固定模型价格；日志中仍会记录 token 数。

失败的调用、被拒绝的请求和上游错误都不计费。

## 示例

```bash
curl https://your-gateway.example/v1/rerank \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-embedding:8b", "query": "中国的首都是哪里？", "documents": ["巴黎是法国的首都。", "北京是中国的首都。"], "top_n": 1, "return_documents": true}'
```

```json
{"results": [{"index": 1, "relevance_score": 0.66, "document": {"text": "北京是中国的首都。"}}], "usage": {"prompt_tokens": 40, "total_tokens": 40}}
```

## 限制

- 重排序模型模式：每次请求最多 33 篇文档，因为 new-api 在首个请求之后最多允许 32 个链式上游请求。文档逐篇打分，文档越多延迟越高，大批量请分批发送。
- 向量模式：每次请求最多 1000 篇文档，同时受网关请求体大小限制。
- 向量模式的分数是 -1 到 1 的余弦相似度，不是校准过的概率；重排序模型模式的分数是 0 到 1 的概率。
- 不支持流式；重排序请求始终一次性返回。
