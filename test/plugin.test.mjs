// Runs the provider hooks the way new-api calls them: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const plugin = await import("../plugin.js");
const { meta, convertRequest, convertResponse, convertStreamEvent, yesProbability } = plugin;

const CTX = { baseUrl: "http://127.0.0.1:11434", path: "/v1/rerank", config: {} };

function ok(body) {
  return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function generateReply(yes, no, promptTokens) {
  return ok({
    response: "yes",
    prompt_eval_count: promptTokens,
    eval_count: 1,
    logprobs: [{
      token: "yes",
      logprob: yes,
      top_logprobs: [{ token: "yes", logprob: yes }, { token: "no", logprob: no }, { token: "Yes", logprob: -9 }],
    }],
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Drives a chained conversion like the host: request, then each response.
function run(config, body, replies) {
  const ctx = Object.assign({}, CTX, { config: config });
  const sent = [];
  let request = convertRequest(ctx, { body: body, model: body.model, stream: false });
  let state = request.state;
  for (const reply of replies) {
    sent.push(request);
    const result = convertResponse(Object.assign({}, ctx, { state: state }), reply);
    if (!result.next) return { sent: sent, result: result };
    request = result.next;
    state = result.state;
  }
  throw new Error("conversation did not finish");
}

test("meta is a plain JSON literal the marketplace can read", () => {
  const source = readFileSync(new URL("../plugin.js", import.meta.url), "utf8");
  const block = source.match(/export const meta = (\{[\s\S]*?\n\});/);
  assert.ok(block, "meta block found");
  assert.deepEqual(JSON.parse(block[1]), meta);
  assert.equal(meta.apiVersion, 1);
  assert.ok(meta.key.length <= 30);
  assert.equal(meta.channelTypes, undefined);
  // new-api rc.50's channel type picker reads plugin.models.length and crashes on null.
  assert.ok(Array.isArray(meta.models) && meta.models.length > 0);
  assert.deepEqual(meta.relay.map((route) => route.incoming_path), ["/v1/rerank", "/v1/models"]);
});

test("embedding mode embeds query and documents in one call and ranks by cosine", () => {
  const body = { model: "qwen3-embedding:8b", query: "capital of China", documents: ["Paris", { text: "Beijing" }, "Tokyo"], top_n: 2, return_documents: true };
  const request = convertRequest(CTX, { body: body, model: "qwen3-embedding:8b", stream: false });
  assert.equal(request.path, "/api/embed");
  assert.equal(request.body.model, "qwen3-embedding:8b");
  assert.equal(request.body.input.length, 4);
  assert.match(request.body.input[0], /^Instruct: .+\nQuery:capital of China$/);
  assert.deepEqual(request.body.input.slice(1), ["Paris", "Beijing", "Tokyo"]);

  const reply = ok({ embeddings: [[1, 0], [0, 1], [1, 0.1], [0.5, 0.5]], prompt_eval_count: 42 });
  const result = convertResponse(Object.assign({}, CTX, { state: request.state }), reply);
  assert.deepEqual(result.body.results.map((r) => r.index), [1, 2]);
  assert.deepEqual(result.body.results[0].document, { text: "Beijing" });
  assert.deepEqual(result.body.results[1].document, { text: "Tokyo" });
  assert.ok(result.body.results[0].relevance_score > 0.99);
  assert.deepEqual(result.body.usage, { prompt_tokens: 42, total_tokens: 42 });
});

test("non-Qwen3 embedding models get the raw query and no documents unless asked", () => {
  const body = { model: "bge-m3", query: "q", documents: ["a", "b"] };
  const request = convertRequest(CTX, { body: body, model: "bge-m3", stream: false });
  assert.equal(request.body.input[0], "q");
  const result = convertResponse(Object.assign({}, CTX, { state: request.state }), ok({ embeddings: [[1, 0], [0, 1], [1, 0]], prompt_eval_count: 5 }));
  assert.deepEqual(result.body.results, [{ index: 1, relevance_score: 1 }, { index: 0, relevance_score: 0 }]);
});

test("reranker models chain one generate request per document and sum the tokens", () => {
  const body = { model: "dengcao/Qwen3-Reranker-4B:Q5_K_M", query: "capital of China", documents: ["Paris is in France", "Beijing is the capital", "Bananas"] };
  const { sent, result } = run({}, body, [generateReply(-3, -0.05, 90), generateReply(-0.01, -5, 88), generateReply(-8, -0.001, 80)]);
  assert.equal(sent.length, 3);
  for (const [i, request] of sent.entries()) {
    assert.equal(request.path, "/api/generate");
    assert.equal(request.body.raw, true);
    assert.equal(request.body.logprobs, true);
    assert.equal(request.body.top_logprobs, 20);
    assert.equal(request.body.options.num_predict, 1);
    assert.equal(request.body.model, body.model);
    assert.ok(request.body.prompt.includes("<Document>: " + body.documents[i] + "<|im_end|>"));
    assert.ok(request.body.prompt.endsWith("<think>\n\n</think>\n\n"));
  }
  assert.deepEqual(result.body.results.map((r) => r.index), [1, 0, 2]);
  assert.ok(result.body.results[0].relevance_score > 0.99);
  assert.ok(result.body.results[2].relevance_score < 0.01);
  assert.deepEqual(result.body.usage, { prompt_tokens: 261, total_tokens: 261 });
});

test("channel config forces the mode and passes num_ctx and the instruction", () => {
  const body = { model: "my-embedder", query: "q", documents: ["a"] };
  const request = convertRequest(Object.assign({}, CTX, { config: { mode: "logprobs", numCtx: 4096, instruction: "Find code" } }), { body: body, model: "my-embedder", stream: false });
  assert.equal(request.path, "/api/generate");
  assert.equal(request.body.options.num_ctx, 4096);
  assert.ok(request.body.prompt.includes("<Instruct>: Find code\n"));
  const embed = convertRequest(Object.assign({}, CTX, { config: { mode: "embedding" } }), { body: Object.assign({}, body, { model: "x-reranker" }), model: "x-reranker", stream: false });
  assert.equal(embed.path, "/api/embed");
  assert.equal(embed.body.options.num_ctx, undefined);
});

test("the mapped upstream model wins over the client's model name", () => {
  const body = { model: "public-rerank", query: "q", documents: ["a"] };
  const request = convertRequest(CTX, { body: body, model: "qwen3-reranker:4b", stream: false });
  assert.equal(request.body.model, "qwen3-reranker:4b");
});

test("bad requests are rejected before anything is sent", () => {
  const send = (body, config) => () => convertRequest(Object.assign({}, CTX, { config: config || {} }), { body: body, model: body.model, stream: false });
  assert.throws(send({ model: "m", query: "", documents: ["a"] }), /query/);
  assert.throws(send({ model: "m", query: "q", documents: [] }), /documents/);
  assert.throws(send({ model: "m", query: "q", documents: ["a"], top_n: 0 }), /top_n/);
  const many = Array.from({ length: 34 }, (_, i) => "d" + i);
  assert.throws(send({ model: "qwen3-reranker", query: "q", documents: many }), /at most 33/);
  assert.doesNotThrow(send({ model: "qwen3-reranker", query: "q", documents: many.slice(0, 33) }));
  assert.doesNotThrow(send({ model: "qwen3-embedding:8b", query: "q", documents: many }));
});

test("upstream failures become errors and are not billed", () => {
  const request = convertRequest(CTX, { body: { model: "missing", query: "q", documents: ["a"] }, model: "missing", stream: false });
  const ctx = Object.assign({}, CTX, { state: request.state });
  const notFound = convertResponse(ctx, { status: 404, headers: {}, body: JSON.stringify({ error: "model \"missing\" not found, try pulling it first" }) });
  assert.equal(notFound.error.status, 404);
  assert.match(notFound.error.message, /not found/);
  assert.equal(notFound.body, undefined);
  assert.match(convertResponse(ctx, ok({ embeddings: [[1]] })).error.message, /1 embeddings for 2 inputs/);
  assert.match(convertResponse(ctx, { status: 200, headers: {}, body: "nope" }).error.message, /invalid JSON/);
  const rerank = convertRequest(CTX, { body: { model: "x-rerank", query: "q", documents: ["a"] }, model: "x-rerank", stream: false });
  assert.match(convertResponse(Object.assign({}, CTX, { state: rerank.state }), ok({ response: "yes", prompt_eval_count: 3 })).error.message, /no logprobs/);
  assert.ok(convertStreamEvent({}, { data: "x" }).error);
});

test("yes probability follows the yes/no softmax", () => {
  assert.equal(yesProbability([{ token: "yes", logprob: Math.log(0.6), top_logprobs: [{ token: "yes", logprob: Math.log(0.6) }, { token: "no", logprob: Math.log(0.2) }] }]).toFixed(4), "0.7500");
  assert.equal(yesProbability([{ token: "no", logprob: -0.1, top_logprobs: [{ token: "no", logprob: -0.1 }] }]), 0);
  assert.equal(yesProbability([{ token: "yes", logprob: -0.1, top_logprobs: [{ token: "yes", logprob: -0.1 }] }]), 1);
  assert.equal(yesProbability([{ token: "yes", logprob: -0.1 }]), 1);
  assert.equal(yesProbability(undefined), null);
});

test("hooks do not mutate their arguments", () => {
  const body = deepFreeze({ model: "qwen3-reranker", query: "q", documents: ["a", { text: "b" }], return_documents: true });
  const ctx = deepFreeze(Object.assign({}, CTX, { config: { mode: "auto" } }));
  const request = convertRequest(ctx, deepFreeze({ body: body, model: body.model, stream: false }));
  const state = deepFreeze(request.state);
  const step = convertResponse(deepFreeze(Object.assign({}, CTX, { state: state })), deepFreeze(generateReply(-0.1, -2, 10)));
  const last = convertResponse(deepFreeze(Object.assign({}, CTX, { state: deepFreeze(step.state) })), deepFreeze(generateReply(-2, -0.1, 10)));
  assert.deepEqual(last.body.results[0].document, { text: "a" });
  assert.deepEqual(last.body.results[1].document, { text: "b" });
});
