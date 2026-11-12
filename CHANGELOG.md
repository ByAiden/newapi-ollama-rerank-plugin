---
changelogVersion: 1
plugin: byaiden_ollama_rerank
version: 1.0.1
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---

# Changelog

## [1.0.1]

### Added

- Rerank endpoint `POST /v1/rerank` for self-hosted Ollama, scoring with reranker logprobs through `/api/generate` (Qwen3-Reranker and its GGUF ports) or with embedding cosine similarity through `/api/embed`, selected by model name or by the channel's scoring mode.
- Token billing from the prompt and output tokens Ollama reports for every upstream request of a call, priced with a model ratio or an expression such as `tier("base", p * 0.114)`.
- Channel settings for the scoring mode, the Qwen3 task instruction and the Ollama context length.
