---
changelogVersion: 1
plugin: byaiden_ollama_rerank
version: 1.0.1
locale: "zh-CN"
---

# Changelog

## [1.0.1]

### Fixed

- 声明默认模型列表，修复 new-api 创建渠道页面崩溃；默认只列重排序模型，避免普通渠道上的向量模型被本插件占用。

## [1.0.0]

### Added

- 为自部署 Ollama 提供重排序接口 `POST /v1/rerank`，可通过 `/api/generate` 用重排序模型 logprobs 打分，或通过 `/api/embed` 用向量余弦相似度打分，按模型名或渠道的打分方式选择。
- 按 Ollama 报告的每个上游请求的输入与输出 token 计费。
- 渠道配置支持打分方式、Qwen3 任务指令和 Ollama 上下文长度。
