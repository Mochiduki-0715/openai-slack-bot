import assert from "node:assert/strict";
import test from "node:test";
import { claudeModel, claudeModelLabel, createClaudeResponse } from "../src/model.mjs";

function mockClient(responses = [{ stop_reason: "end_turn", content: [{ type: "text", text: "確認しました。" }] }]) {
  const requests = [];
  const client = {
    messages: {
      stream(request, options) {
        const response = responses[requests.length] ?? responses.at(-1);
        requests.push({ body: structuredClone(request), options });
        return { async finalMessage() {
          if (response instanceof Error) throw response;
          return typeof response === "function" ? response() : response;
        } };
      },
    },
  };
  return { client, requests };
}

const input = [{ role: "user", content: "質問です。" }];
const imageData = "data:image/png;base64,aW1hZ2U=";
const pdfData = "data:application/pdf;base64,cGRm";

test("translates conversation, images, and PDF into native messages at fixed Fable/max", async () => {
  const originalInput = [
    { role: "user", content: "前の質問" },
    { role: "assistant", content: "前の回答" },
    { role: "user", content: [
      { type: "input_text", text: "画像とPDFを比較して" },
      { type: "input_image", image_url: imageData, detail: "auto" },
      { type: "input_file", file_data: pdfData, filename: "資料.pdf" },
    ] },
  ];
  const originalCopy = structuredClone(originalInput);
  const { client, requests } = mockClient();
  const response = await createClaudeResponse(client, {
    instructions: "丁寧に回答してください。",
    input: originalInput,
    model: "claude-sonnet-5",
    output_config: { effort: "low" },
  });

  assert.deepEqual(response, { output_text: "確認しました。", output: [] });
  assert.equal(claudeModel, "claude-fable-5-1");
  assert.equal(claudeModelLabel, "Fable 5.1");
  assert.equal(requests.length, 1);
  const { body, options } = requests[0];
  assert.equal(body.model, claudeModel);
  assert.equal(body.max_tokens, 64000);
  assert.deepEqual(body.thinking, { type: "adaptive", display: "omitted" });
  assert.deepEqual(body.output_config, { effort: "max" });
  assert.equal(body.system, "丁寧に回答してください。");
  assert.deepEqual(body.messages, [
    originalInput[0], originalInput[1],
    { role: "user", content: [
      { type: "text", text: "画像とPDFを比較して" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" }, title: "資料.pdf" },
    ] },
  ]);
  assert.deepEqual(body.tools, [{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"], max_uses: 5 }]);
  assert.equal(options.maxRetries, 0);
  assert.ok(options.timeout > 0 && options.timeout <= 600000);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(originalInput, originalCopy);
});

test("returns cited Slack links without thinking, tool data, or unsafe URLs", async () => {
  const citation = { type: "web_search_result_location", url: "https://example.com/report", title: "資料<更新>|最新版" };
  const { client } = mockClient([{ stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "not visible", signature: "secret-signature" },
    { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "query" } },
    { type: "web_search_tool_result", tool_use_id: "search-1", content: [{ encrypted_content: "encrypted" }] },
    { type: "text", text: "根拠を確認しました。", citations: [citation, citation,
      { ...citation, url: "javascript:alert(1)" },
      { ...citation, url: "https://name:password@example.com/" },
      { ...citation, url: "not a url" },
    ] },
  ] }]);

  assert.deepEqual(await createClaudeResponse(client, { input }), {
    output_text: "根拠を確認しました。 <https://example.com/report|資料&lt;更新&gt;｜最新版>",
    output: [],
  });
});

test("continues paused turns with complete signed and encrypted content and identical tools", async () => {
  const pausedContent = [
    { type: "thinking", thinking: "", signature: "unchanged-signature" },
    { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "query" } },
    { type: "web_search_tool_result", tool_use_id: "search-1", content: [{ type: "web_search_result", encrypted_content: "unchanged-search", url: "https://example.com" }] },
    { type: "server_tool_use", id: "search-2", name: "web_search", input: { query: "next query" } },
  ];
  const { client, requests } = mockClient([
    { stop_reason: "pause_turn", content: pausedContent },
    { stop_reason: "end_turn", content: [{ type: "text", text: "検索が完了しました。" }] },
  ]);
  const result = await createClaudeResponse(client, { input });

  assert.equal(result.output_text, "検索が完了しました。");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.messages, input);
  assert.deepEqual(requests[1].body.messages, [...input, { role: "assistant", content: pausedContent }]);
  assert.deepEqual(requests[0].body.tools, requests[1].body.tools);
  assert.equal(requests[0].options.signal, requests[1].options.signal);
  assert.ok(requests[1].options.timeout <= requests[0].options.timeout);
});

test("stops after five continuations without falling back or returning partial output", async () => {
  const { client, requests } = mockClient([{ stop_reason: "pause_turn", content: [{ type: "text", text: "調査中" }] }]);
  await assert.rejects(createClaudeResponse(client, { input }), /継続回数の上限/);
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ body }) => body.model === claudeModel && body.output_config.effort === "max"));
});

test("surfaces truncated, refused, incomplete, and search-failed responses explicitly", async () => {
  for (const [response, expected] of [
    [{ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }, /トークン上限/],
    [{ stop_reason: "model_context_window_exceeded", content: [] }, /トークン上限/],
    [{ stop_reason: "refusal", content: [{ type: "text", text: "declined" }] }, /拒否/],
    [{ stop_reason: "tool_use", content: [{ type: "tool_use", name: "image_generation" }] }, /未対応のツール/],
    [{ stop_reason: "end_turn", content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }] }, /max_uses_exceeded/],
    [{ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }] }, /回答本文/],
    [{ stop_reason: "stop_sequence", content: [] }, /正常に完了/],
  ]) {
    const { client, requests } = mockClient([response]);
    await assert.rejects(createClaudeResponse(client, { input }), expected);
    assert.equal(requests.length, 1);
  }
});

test("does not retry or downgrade an API or streaming failure", async () => {
  const failure = Object.assign(new Error("model unavailable"), { status: 404 });
  const { client, requests } = mockClient([failure]);
  await assert.rejects(createClaudeResponse(client, { input }), (error) => error === failure);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, claudeModel);
});

test("rejects unsupported or malformed attachments before requesting Claude", async () => {
  for (const block of [
    { type: "input_image", image_url: "https://example.com/private.png" },
    { type: "input_image", image_url: "data:image/svg+xml;base64,aW1hZ2U=" },
    { type: "input_file", file_data: "data:audio/mp3;base64,YXVkaW8=" },
    { type: "input_file", file_data: "data:application/octet-stream;base64,cGRm" },
    { type: "input_image", image_url: "data:image/png;base64,invalid!" },
    { type: "input_image", image_url: "data:image/png;base64,a===" },
    { type: "input_image", image_url: "data:image/png;base64,aW1hZ2V=" },
    { type: "input_audio", data: "YXVkaW8=" },
  ]) {
    const { client, requests } = mockClient();
    await assert.rejects(createClaudeResponse(client, { input: [{ role: "user", content: [block] }] }), { name: "ClaudeRequestError" });
    assert.equal(requests.length, 0);
  }
});

test("rejects oversized images, aggregate payloads, and excessive image counts", async () => {
  for (const options of [
    { input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"a".repeat(10 * 1024 * 1024 + 4)}` }] }] },
    { instructions: "あ".repeat(11 * 1024 * 1024), input },
    { input: [{ role: "user", content: Array.from({ length: 601 }, () => ({ type: "input_image", image_url: imageData })) }] },
  ]) {
    const { client, requests } = mockClient();
    await assert.rejects(createClaudeResponse(client, options), /上限|MB|600件/);
    assert.equal(requests.length, 0);
  }
});

test("applies one ten-minute deadline across the whole response", async () => {
  const originalNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  try {
    const { client, requests } = mockClient([() => {
      now += 600000;
      return { stop_reason: "pause_turn", content: [] };
    }]);
    await assert.rejects(createClaudeResponse(client, { input }), /10分/);
    assert.equal(requests.length, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("aborts an in-flight stream when the overall deadline expires", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const client = { messages: { stream(_request, options) {
    signal = options.signal;
    return { finalMessage: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
    }) };
  } } };
  const response = createClaudeResponse(client, { input });
  context.mock.timers.tick(600000);

  await assert.rejects(response, /10分/);
  assert.equal(signal.aborted, true);
});

test("checks the request limit again when paused tool state enlarges the payload", async () => {
  const { client, requests } = mockClient([{ stop_reason: "pause_turn", content: [
    { type: "thinking", thinking: "", signature: "a".repeat(30 * 1024 * 1024) },
  ] }]);

  await assert.rejects(createClaudeResponse(client, { input }), /30MB/);
  assert.equal(requests.length, 1);
});
