import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { botModelLabel, createBotResponse } from "../src/bot-model.mjs";
import { selectRequest } from "../src/request-selection.mjs";

function mockOpenAI({ status = 200, body } = {}) {
  const requests = [];
  const client = new OpenAI({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        method: init.method,
        body: JSON.parse(init.body),
      });
      return new Response(
        JSON.stringify(body ?? {
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "確認しました。", annotations: [] }],
          }],
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { client, requests };
}

function assertFixedPolicy(request) {
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).pathname, "/v1/responses");
  assert.equal(request.body.model, "gpt-6-astra");
  assert.deepEqual(request.body.reasoning, { mode: "pro", effort: "max" });
}

test("sends ordinary conversation and web search through the SDK with Astra Pro/max", async () => {
  const { client, requests } = mockOpenAI();
  const options = {
    instructions: "日本語で回答してください。",
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    input: [
      { role: "user", content: "前の質問" },
      { role: "assistant", content: "前の回答" },
      { role: "user", content: [{ type: "input_text", text: "今日のニュースを調べて" }] },
    ],
  };

  const response = await createBotResponse(client, options);

  assert.equal(requests.length, 1);
  assertFixedPolicy(requests[0]);
  assert.deepEqual(requests[0].body.input, options.input);
  assert.deepEqual(requests[0].body.tools, options.tools);
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.equal(requests[0].body.instructions, options.instructions);
  assert.equal(response.output_text, "確認しました。");
});

test("image commands keep the image generation model and forced tool choice", async () => {
  const { client, requests } = mockOpenAI();
  const selection = selectRequest("image 雨上がりの東京");
  const options = {
    tools: [
      { type: "web_search" },
      { type: "image_generation", action: "auto", model: "gpt-image-2" },
    ],
    tool_choice: selection.forceImageGeneration ? { type: "image_generation" } : "auto",
    input: [{ role: "user", content: [{ type: "input_text", text: selection.prompt }] }],
  };

  await createBotResponse(client, options);

  assert.equal(requests.length, 1);
  assertFixedPolicy(requests[0]);
  assert.deepEqual(requests[0].body.tools, options.tools);
  assert.deepEqual(requests[0].body.tool_choice, { type: "image_generation" });
  assert.equal(requests[0].body.input[0].content[0].text, "雨上がりの東京");
  assert.equal(botModelLabel, "Astra");
});

test("image reading preserves the attached image under the fixed policy", async () => {
  const { client, requests } = mockOpenAI();
  const input = [{
    role: "user",
    content: [
      { type: "input_text", text: "この画像を説明して" },
      { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "auto" },
    ],
  }];

  await createBotResponse(client, { input });

  assert.equal(requests.length, 1);
  assertFixedPolicy(requests[0]);
  assert.deepEqual(requests[0].body.input, input);
});

test("media analysis preserves PDF, transcript, and video frame inputs", async () => {
  const { client, requests } = mockOpenAI();
  const input = [{
    role: "user",
    content: [
      { type: "input_text", text: "資料と動画を要約して\n[00:00] 説明を始めます。" },
      { type: "input_file", filename: "sample.pdf", file_data: "data:application/pdf;base64,cGRm" },
      { type: "input_image", image_url: "data:image/jpeg;base64,ZnJhbWU=", detail: "low" },
    ],
  }];

  await createBotResponse(client, { input });

  assert.equal(requests.length, 1);
  assertFixedPolicy(requests[0]);
  assert.deepEqual(requests[0].body.input, input);
  assert.equal("tools" in requests[0].body, false);
});

test("stale caller model and reasoning options cannot downgrade the request", async () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const { client, requests } = mockOpenAI();
    const options = {
      model,
      reasoning: { effort: "low" },
      input: "処理待ちだった資料を要約して",
    };
    const originalOptions = structuredClone(options);

    await createBotResponse(client, options);

    assert.equal(requests.length, 1);
    assertFixedPolicy(requests[0]);
    assert.equal(requests[0].body.input, options.input);
    assert.deepEqual(options, originalOptions);
  }
});

test("legacy environment variables cannot change the model, reasoning, or label", async () => {
  const previousModel = process.env.OPENAI_MODEL;
  const previousEffort = process.env.OPENAI_REASONING_EFFORT;
  try {
    process.env.OPENAI_MODEL = "gpt-5.6-terra";
    process.env.OPENAI_REASONING_EFFORT = "low";
    // A fresh import catches settings read once during process startup as well.
    const policyUrl = new URL("../src/bot-model.mjs?legacy-environment", import.meta.url);
    const policy = await import(policyUrl.href);
    const { client, requests } = mockOpenAI();

    await policy.createBotResponse(client, { input: "通常の質問" });

    assert.equal(requests.length, 1);
    assertFixedPolicy(requests[0]);
    assert.equal(policy.botModelLabel, "Astra");
  } finally {
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
    if (previousEffort === undefined) delete process.env.OPENAI_REASONING_EFFORT;
    else process.env.OPENAI_REASONING_EFFORT = previousEffort;
  }
});

test("a rejected Astra request surfaces the error without a model or effort fallback", async () => {
  const { client, requests } = mockOpenAI({
    status: 400,
    body: { error: { message: "Pro mode unavailable", type: "invalid_request_error" } },
  });

  await assert.rejects(
    createBotResponse(client, { input: "通常の質問" }),
    (error) => error.status === 400 && error.message.includes("Pro mode unavailable"),
  );

  assert.equal(requests.length, 1);
  assertFixedPolicy(requests[0]);
});
