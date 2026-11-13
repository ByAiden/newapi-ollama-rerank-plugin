// Ollama Rerank: serves the Jina/Cohere-style /v1/rerank endpoint on a
// type-61 channel whose upstream is a self-hosted Ollama server.
//
// Ollama has no rerank endpoint, so the plugin scores documents with what it
// does have:
//   - logprobs: a decoder reranker (Qwen3-Reranker and its GGUF ports) is asked
//     the official yes/no question once per document through /api/generate,
//     and the score is P(yes) / (P(yes) + P(no)) read from top_logprobs. One
//     upstream request per document, chained by the host.
//   - embedding: one /api/embed call embeds the query and every document; the
//     score is the cosine similarity of each document to the query.
//
// Billing: the reply carries usage.total_tokens = the tokens Ollama reports
// (prompt_eval_count + eval_count of every request), which new-api's rerank
// handler bills at the model's price.

export const meta = {
  "apiVersion": 1,
  "key": "ollama-rerank",
  "name": { "en": "Ollama Rerank", "zh": "Ollama 重排序" },
  "version": "1.1.0",
  "author": { "name": "ByAiden", "url": "https://github.com/ByAiden" },
  "description": {
    "en": "Rerank endpoint for self-hosted Ollama models with token billing",
    "zh": "为自部署的 Ollama 模型提供按 token 计费的重排序接口"
  },
  "icon": "Ollama",
  "baseUrl": "http://127.0.0.1:11434",
  "models": ["dengcao/Qwen3-Reranker-8B:Q8_0"],
  "relay": [
    { "incoming_path": "/v1/rerank", "upstream_path": "/api/embed", "converter": "plugin" },
    { "incoming_path": "/v1/models", "upstream_path": "/v1/models" }
  ],
  "channelConfig": {
    "type": "object",
    "properties": {
      "mode": {
        "type": "string",
        "title": { "en": "Scoring mode", "zh": "打分方式" },
        "description": {
          "en": "Auto uses logprobs for model names containing rerank and embedding for the others",
          "zh": "自动：模型名含 rerank 时用 logprobs，其余用向量相似度"
        },
        "enum": ["auto", "logprobs", "embedding"],
        "enumTitles": [
          { "en": "Auto", "zh": "自动" },
          { "en": "Reranker logprobs", "zh": "重排序模型 logprobs" },
          { "en": "Embedding cosine similarity", "zh": "向量余弦相似度" }
        ],
        "default": "auto"
      },
      "instruction": {
        "type": "string",
        "title": { "en": "Task instruction", "zh": "任务指令" },
        "description": {
          "en": "Instruction given to Qwen3 rerankers and Qwen3 embedding queries",
          "zh": "传给 Qwen3 重排序模型和 Qwen3 向量查询的指令"
        },
        "default": "Given a web search query, retrieve relevant passages that answer the query",
        "maxLength": 1024
      },
      "numCtx": {
        "type": "integer",
        "title": { "en": "Context length", "zh": "上下文长度" },
        "description": {
          "en": "Ollama num_ctx for each request, 0 keeps the server default",
          "zh": "每次请求的 Ollama num_ctx，0 表示使用服务端默认值"
        },
        "minimum": 0,
        "maximum": 262144,
        "default": 0
      }
    }
  },
  "keyHint": {
    "en": "Any value; Ollama does not check keys",
    "zh": "任意值；Ollama 不校验密钥"
  }
};

// The host sends at most 32 requests after the first one per client request.
const MAX_LOGPROBS_DOCUMENTS = 33;
const MAX_DOCUMENTS = 1000;
const DEFAULT_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query";

const RERANKER_PREFIX =
  "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. " +
  "Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n";
const RERANKER_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function documentText(document) {
  if (typeof document === "string") return document;
  if (isObject(document) && typeof document.text === "string") return document.text;
  return JSON.stringify(document);
}

function resolveMode(config, model) {
  const mode = config && typeof config.mode === "string" ? config.mode : "auto";
  if (mode === "logprobs" || mode === "embedding") return mode;
  return /rerank/i.test(model) ? "logprobs" : "embedding";
}

function ollamaOptions(numCtx) {
  const options = { temperature: 0 };
  if (numCtx > 0) options.num_ctx = numCtx;
  return options;
}

function generateRequest(state) {
  const content =
    "<Instruct>: " + state.instruction + "\n<Query>: " + state.query + "\n<Document>: " + state.documents[state.next];
  const options = ollamaOptions(state.numCtx);
  options.num_predict = 1;
  return {
    path: "/api/generate",
    method: "POST",
    stream: false,
    body: {
      model: state.model,
      prompt: RERANKER_PREFIX + content + RERANKER_SUFFIX,
      raw: true,
      stream: false,
      logprobs: true,
      top_logprobs: 20,
      options: options,
    },
  };
}

function embedQuery(model, instruction, query) {
  // Qwen3-Embedding expects instructed queries and plain documents.
  if (/qwen3[-_]?embedding/i.test(model)) return "Instruct: " + instruction + "\nQuery:" + query;
  return query;
}

export function convertRequest(ctx, request) {
  if (!request || !isObject(request.body)) throw badRequest("rerank request body must be a JSON object");
  const body = request.body;
  const model = typeof request.model === "string" && request.model ? request.model : body.model;
  if (typeof model !== "string" || !model) throw badRequest("model is required");
  if (typeof body.query !== "string" || !body.query.trim()) throw badRequest("query must be a non-empty string");
  if (!Array.isArray(body.documents) || body.documents.length === 0) {
    throw badRequest("documents must be a non-empty array");
  }
  if (body.top_n !== undefined && body.top_n !== null && (!Number.isInteger(body.top_n) || body.top_n < 1)) {
    throw badRequest("top_n must be a positive integer");
  }

  const config = isObject(ctx && ctx.config) ? ctx.config : {};
  const mode = resolveMode(config, model);
  const limit = mode === "logprobs" ? MAX_LOGPROBS_DOCUMENTS : MAX_DOCUMENTS;
  if (body.documents.length > limit) {
    throw badRequest(
      mode === "logprobs"
        ? "at most " + limit + " documents per request with a reranker model; split the request"
        : "at most " + limit + " documents per request",
    );
  }

  const instruction =
    typeof config.instruction === "string" && config.instruction.trim() ? config.instruction : DEFAULT_INSTRUCTION;
  const numCtx = Number.isInteger(config.numCtx) && config.numCtx > 0 ? config.numCtx : 0;
  const state = {
    mode: mode,
    model: model,
    query: body.query,
    instruction: instruction,
    numCtx: numCtx,
    documents: body.documents.map(documentText),
    originals: body.return_documents === true ? body.documents.slice() : null,
    topN: Number.isInteger(body.top_n) ? body.top_n : null,
    next: 0,
    scores: [],
    promptTokens: 0,
    completionTokens: 0,
  };

  if (mode === "logprobs") {
    const first = generateRequest(state);
    first.state = state;
    return first;
  }

  return {
    path: "/api/embed",
    method: "POST",
    stream: false,
    body: {
      model: model,
      input: [embedQuery(model, instruction, body.query)].concat(state.documents),
      truncate: true,
      options: ollamaOptions(numCtx),
    },
    state: state,
  };
}

function upstreamError(response) {
  let message = "";
  try {
    const parsed = JSON.parse(response.body);
    if (parsed && typeof parsed.error === "string") message = parsed.error;
    else if (parsed && isObject(parsed.error) && typeof parsed.error.message === "string") message = parsed.error.message;
  } catch (_) {
    message = typeof response.body === "string" ? response.body.slice(0, 512) : "";
  }
  return {
    error: {
      status: response.status >= 400 && response.status <= 599 ? response.status : 502,
      message: "ollama: " + (message || "request failed with status " + response.status),
      type: "upstream_error",
    },
  };
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// P(yes) / (P(yes) + P(no)) over the first generated token, as the official
// Qwen3-Reranker scorer computes it.
export function yesProbability(logprobs) {
  const first = Array.isArray(logprobs) ? logprobs[0] : null;
  if (!isObject(first)) return null;
  const candidates = Array.isArray(first.top_logprobs) && first.top_logprobs.length ? first.top_logprobs : [first];
  let yes = -Infinity;
  let no = -Infinity;
  for (const candidate of candidates) {
    if (!isObject(candidate) || !Number.isFinite(candidate.logprob)) continue;
    if (candidate.token === "yes") yes = Math.max(yes, candidate.logprob);
    else if (candidate.token === "no") no = Math.max(no, candidate.logprob);
  }
  if (yes === -Infinity && no === -Infinity) return 0;
  if (yes === -Infinity) return 0;
  if (no === -Infinity) return 1;
  return 1 / (1 + Math.exp(no - yes));
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function finalReply(state) {
  const results = state.scores.map(function (score, index) {
    const result = { index: index, relevance_score: score };
    if (state.originals) {
      const original = state.originals[index];
      result.document = typeof original === "string" ? { text: original } : original;
    }
    return result;
  });
  results.sort(function (a, b) {
    return b.relevance_score - a.relevance_score || a.index - b.index;
  });
  const total = state.promptTokens + state.completionTokens;
  return {
    body: {
      model: state.model,
      results: state.topN ? results.slice(0, state.topN) : results,
      usage: { prompt_tokens: total, total_tokens: total },
    },
  };
}

export function convertResponse(ctx, response) {
  const state = ctx && ctx.state;
  if (!isObject(state)) return { error: { status: 500, message: "missing rerank state" } };
  if (response.status < 200 || response.status > 299) return upstreamError(response);
  if (typeof response.body !== "string") return { error: { status: 502, message: "ollama returned a non-text body" } };

  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch (_) {
    return { error: { status: 502, message: "ollama returned invalid JSON" } };
  }
  if (!isObject(parsed)) return { error: { status: 502, message: "ollama returned an unexpected body" } };
  if (typeof parsed.error === "string") return { error: { status: 502, message: "ollama: " + parsed.error } };

  if (state.mode === "embedding") {
    const embeddings = parsed.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== state.documents.length + 1) {
      return { error: { status: 502, message: "ollama returned " + (Array.isArray(embeddings) ? embeddings.length : 0) + " embeddings for " + (state.documents.length + 1) + " inputs" } };
    }
    const scores = [];
    for (let i = 1; i < embeddings.length; i++) {
      const score = cosine(embeddings[0], embeddings[i]);
      if (score === null) return { error: { status: 502, message: "ollama returned malformed embeddings" } };
      scores.push(score);
    }
    return finalReply(Object.assign({}, state, { scores: scores, promptTokens: count(parsed.prompt_eval_count) }));
  }

  const score = yesProbability(parsed.logprobs);
  if (score === null) {
    return { error: { status: 502, message: "ollama returned no logprobs; upgrade Ollama to a version that supports logprobs" } };
  }
  const next = Object.assign({}, state, {
    next: state.next + 1,
    scores: state.scores.concat([score]),
    promptTokens: state.promptTokens + count(parsed.prompt_eval_count),
    completionTokens: state.completionTokens + count(parsed.eval_count),
  });
  if (next.next < next.documents.length) {
    const request = generateRequest(next);
    return { next: request, state: next };
  }
  return finalReply(next);
}

export function convertStreamEvent() {
  return { error: { status: 400, message: "rerank does not stream" } };
}
