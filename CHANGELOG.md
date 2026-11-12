---
changelogVersion: 1
plugin: byaiden_ollama_rerank
version: 1.0.0
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---

# Changelog

## [1.0.0]

### Added

- Rerank endpoint `POST /v1/rerank` for self-hosted Ollama, scoring with reranker logprobs through `/api/generate` or with embedding cosine similarity through `/api/embed`, selected per model or by the channel's scoring mode.
- Token billing from the prompt and output tokens Ollama reports for every upstream request of a call.
- Channel settings for the scoring mode, the Qwen3 task instruction and the Ollama context length.
