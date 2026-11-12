---
locale: en
translations:
  zh-CN: README.zh-CN.md
---

# Ollama Rerank

**English** | [简体中文](README.zh-CN.md)

Serves the Jina/Cohere-style `POST /v1/rerank` endpoint from a self-hosted Ollama server and bills every call by the tokens Ollama actually processed. Ollama has no rerank endpoint of its own, so the plugin scores documents in one of two ways:

- Reranker logprobs: for a decoder reranker such as Qwen3-Reranker, each document is sent to `/api/generate` with the official yes/no prompt, and the score is `P(yes) / (P(yes) + P(no))` from the first token's `top_logprobs`. One upstream request per document.
- Embedding cosine similarity: for an embedding model such as `qwen3-embedding:8b`, one `/api/embed` call embeds the query and all documents, and the score is the cosine similarity to the query.

Requires new-api v1.0.0-rc.50 or later (provider plugins) and an Ollama version that returns `logprobs` from `/api/generate` for the reranker mode.

## Channel setup

1. Install the plugin, then add a channel of type Task Plugin and bind it to this plugin.
2. Base URL: the Ollama origin without `/v1`, for example `http://127.0.0.1:11434` or a private tailnet address. The default is `http://127.0.0.1:11434`.
3. Key: any value. Ollama does not check keys; protect the server with network access rules or an authenticating proxy.
4. Models: the exact Ollama model names, for example `dengcao/Qwen3-Reranker-8B:Q8_0` (the plugin's default) or an embedding model such as `qwen3-embedding:8b`. Use model mapping to publish a friendlier name. A model appears on the pricing pages only after an enabled channel lists it.
5. Channel settings:
   - Scoring mode: Auto (default) uses reranker logprobs when the model name contains `rerank`, otherwise embedding cosine similarity. Pick a mode explicitly when the name does not say.
   - Task instruction: the instruction given to Qwen3 rerankers and to Qwen3 embedding queries.
   - Context length: Ollama `num_ctx` per request; 0 keeps the server default. Raise it when query plus document exceeds the model default, otherwise Ollama truncates the prompt.

## Models and endpoints

| Client endpoint | Upstream | Notes |
| --- | --- | --- |
| `POST /v1/rerank` | `/api/generate` per document (reranker) or one `/api/embed` (embedding) | Request fields: `model`, `query`, `documents` (strings or `{text}` objects), `top_n`, `return_documents` |
| `GET /v1/models` | `/v1/models` | Model list for the channel form |

## Billing

The reply carries `usage.total_tokens`, the sum of `prompt_eval_count` and `eval_count` Ollama reported for every upstream request of the call (cached prompt tokens included). new-api bills it as prompt tokens at the model's price:

- Per token: set a model ratio for each model name. Ratio 1 bills 1 quota unit per token, which is USD 2 per million tokens at the default quota rate.
- Expression: `tier("base", p * 0.114)` charges USD 0.114 per million tokens; replace 0.114 with your price per million tokens.
- Per call: set a fixed model price instead; the token count still appears in the log.

Failed calls, rejected requests and upstream errors are not billed.

## Example

```bash
curl https://your-gateway.example/v1/rerank \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-embedding:8b", "query": "What is the capital of China?", "documents": ["Paris is the capital of France.", "Beijing is the capital of China."], "top_n": 1, "return_documents": true}'
```

```json
{"results": [{"index": 1, "relevance_score": 0.66, "document": {"text": "Beijing is the capital of China."}}], "usage": {"prompt_tokens": 40, "total_tokens": 40}}
```

## Limits

- Reranker mode: at most 33 documents per request, because new-api allows 32 chained upstream requests after the first. Documents are scored one after another, so latency grows with the number of documents. Split larger batches.
- Embedding mode: at most 1000 documents per request, within the gateway's request body limit.
- Embedding scores are cosine similarities in the range -1 to 1, not calibrated probabilities. Reranker scores are probabilities in the range 0 to 1.
- Streaming is not supported; rerank requests are always answered in one response.
