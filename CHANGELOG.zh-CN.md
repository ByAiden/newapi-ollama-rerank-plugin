---
changelogVersion: 1
plugin: byaiden_ollama_rerank
version: 1.0.0
locale: "zh-CN"
---

# Changelog

## [1.0.0]

### Added

- 为自部署 Ollama 提供重排序接口 `POST /v1/rerank`，可通过 `/api/generate` 用重排序模型 logprobs 打分，或通过 `/api/embed` 用向量余弦相似度打分，按模型名或渠道的打分方式选择。
- 按 Ollama 报告的每个上游请求的输入与输出 token 计费。
- 渠道配置支持打分方式、Qwen3 任务指令和 Ollama 上下文长度。
