// Replays the host's provider-plugin chain against a real Ollama server.
// Usage: node scripts/live-test.mjs <model> [mode] [baseUrl]
import { convertRequest, convertResponse } from "../plugin.js";

const [model, mode = "auto", baseUrl = "http://127.0.0.1:11434"] = process.argv.slice(2);
if (!model) {
  console.error("usage: node scripts/live-test.mjs <model> [auto|logprobs|embedding] [baseUrl]");
  process.exit(2);
}

const body = {
  model: model,
  query: "What is the capital of China?",
  documents: [
    "The capital of France is Paris.",
    "Beijing is the capital of the People's Republic of China.",
    "Bananas are rich in potassium.",
    "China's largest city by population is Shanghai.",
    "北京是中华人民共和国的首都。",
  ],
  top_n: 3,
  return_documents: true,
};

const ctx = { baseUrl: baseUrl, path: "/v1/rerank", config: { mode: mode } };
const started = Date.now();
let request = convertRequest(ctx, { body: body, model: model, stream: false });
let state = request.state;
let calls = 0;
for (;;) {
  calls++;
  const response = await fetch(baseUrl + request.path, {
    method: request.method || "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer placeholder" },
    body: JSON.stringify(request.body),
  });
  const result = convertResponse(Object.assign({}, ctx, { state: state }), {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  });
  if (result.error) {
    console.log(JSON.stringify({ calls: calls, error: result.error }, null, 2));
    process.exit(1);
  }
  if (result.next) {
    request = result.next;
    state = result.state;
    continue;
  }
  console.log(JSON.stringify({ model: model, mode: state.mode, upstream_calls: calls, ms: Date.now() - started, reply: result.body }, null, 2));
  break;
}
