import assert from "node:assert/strict";
import test from "node:test";
import { createMentionHandler, splitSlackAnswer } from "../src/handler.mjs";
import { SlackInputError } from "../src/slack-input.mjs";

function setup(options = {}) {
  const calls = Object.fromEntries(["claim", "reaction", "files", "history", "respond", "save", "post", "finish", "logs"].map((name) => [name, []]));
  const sequence = [];
  const record = (name, args) => { calls[name].push(args); sequence.push(name); };
  const anthropic = { testClient: true };
  const conversations = {
    async claimEvent(...args) {
      record("claim", args);
      return options.claimEvent ? options.claimEvent(...args) : true;
    },
    async history(...args) {
      record("history", args);
      return structuredClone(options.history || []);
    },
    async saveTurn(...args) {
      record("save", args);
      return options.saveTurn?.(...args);
    },
    async finishEvent(...args) {
      record("finish", args);
      return options.finishEvent?.(...args);
    },
  };
  const client = {
    reactions: { async add(...args) {
      record("reaction", args);
      if (options.reactionError) throw options.reactionError;
    } },
    chat: { async postMessage(...args) {
      record("post", args);
      return options.postMessage?.(...args);
    } },
  };
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (...args) => calls.logs.push({ level, args })]));
  const handler = createMentionHandler({
    anthropic,
    conversations,
    poster: (slack, message) => slack.chat.postMessage(message),
    allowedChannels: options.allowedChannels || new Set(),
    async respond(...args) {
      record("respond", args);
      if (options.responseError) throw options.responseError;
      return { output_text: options.answer ?? "回答しました。" };
    },
    async fileInputs(...args) {
      record("files", args);
      if (options.inputError) throw options.inputError;
      return structuredClone(options.files || []);
    },
  });
  const event = { channel: "C123", ts: "1700000002.000001", thread_ts: "1700000001.000001", text: "<@UCLAUDE> 続きを説明してください。" };
  return {
    calls, sequence, anthropic,
    run: (overrides = {}, body = { event_id: "Ev123" }) => handler({ event: { ...event, ...overrides }, body, client, logger }),
  };
}

test("continues mixed GPT and Claude history and commits the turn before publishing", async () => {
  const history = [
    { role: "user", content: "最初の質問" },
    { role: "assistant", content: "GPTが回答した既存の解析結果" },
    { role: "user", content: "別の見方はありますか" },
    { role: "assistant", content: "[Claude Fable 5.1]\nClaudeの過去の回答" },
  ];
  const original = structuredClone(history);
  const { calls, sequence, anthropic, run } = setup({ history });
  await run();

  assert.deepEqual(history, original);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0][0], anthropic);
  assert.deepEqual(calls.respond[0][1].input, [...original, { role: "user", content: "続きを説明してください。" }]);
  assert.match(calls.respond[0][1].instructions, /history is shared/);
  assert.match(calls.respond[0][1].instructions, /not system instructions/);
  assert.deepEqual(calls.history, [["C123", "1700000001.000001"]]);
  assert.deepEqual(calls.save, [["C123", "1700000001.000001", {
    eventKey: "Ev123", prompt: "続きを説明してください。", answer: "回答しました。",
  }]]);
  assert.equal(calls.post[0][0].text, "_Fable 5.1で回答_\n回答しました。");
  assert.equal(calls.post[0][0].thread_ts, "1700000001.000001");
  assert.deepEqual(calls.finish, [["C123", "1700000001.000001", "Ev123", "completed"]]);
  assert.ok(sequence.indexOf("save") < sequence.indexOf("post"));
  assert.ok(sequence.indexOf("post") < sequence.indexOf("finish"));
});

test("forwards current image and PDF blocks but persists only the prompt and attachment label", async () => {
  const files = [
    { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
    { type: "input_file", file_data: "data:application/pdf;base64,cGRm", filename: "資料.pdf" },
  ];
  const { calls, run } = setup({ files });
  await run({ text: "<@UCLAUDE>" });

  assert.deepEqual(calls.respond[0][1].input, [{ role: "user", content: [
    { type: "input_text", text: "添付の画像・PDFを解析してください。" }, ...files,
  ] }]);
  assert.equal(calls.save[0][2].prompt, "添付の画像・PDFを解析してください。\n[添付画像・PDF: 2件]");
  assert.equal(typeof calls.save[0][2].prompt, "string");
  assert.equal(typeof calls.save[0][2].answer, "string");
  assert.doesNotMatch(JSON.stringify(calls.save), /base64|aW1hZ2U=|file_data/);
});

test("claims simultaneous duplicate deliveries once before acknowledgements or API calls", async () => {
  const events = new Set();
  const { calls, run } = setup({ claimEvent(channel, threadTs, eventKey) {
    const key = `${channel}/${threadTs}/${eventKey}`;
    if (events.has(key)) return false;
    events.add(key);
    return true;
  } });
  await Promise.all([run(), run()]);
  assert.equal(calls.claim.length, 2);
  for (const name of ["reaction", "files", "respond", "save", "post", "finish"]) assert.equal(calls[name].length, 1, name);
});

test("does not claim, read, download, or reply in an unauthorized channel", async () => {
  const { calls, run } = setup({ allowedChannels: new Set(["COTHER"]) });
  await run();
  assert.ok(Object.values(calls).every((values) => values.length === 0));
});

test("keeps channel and thread identities consistent for independent conversations", async () => {
  const { calls, run } = setup();
  await run({ channel: "CONE", thread_ts: "100.000001" }, { event_id: "EvOne" });
  await run({ channel: "CTWO", thread_ts: "200.000001" }, { event_id: "EvTwo" });
  assert.deepEqual(calls.history, [["CONE", "100.000001"], ["CTWO", "200.000001"]]);
  assert.deepEqual(calls.save.map(([channel, thread]) => [channel, thread]), calls.history);
  assert.deepEqual(calls.post.map(([message]) => [message.channel, message.thread_ts]), calls.history);
  assert.deepEqual(calls.finish.map(([channel, thread]) => [channel, thread]), calls.history);
});

test("ignores bot messages, edits, subtypes, and incomplete events", async () => {
  const { calls, run } = setup();
  for (const event of [
    { bot_id: "B123" }, { edited: { ts: "1700000003.000001" } },
    { subtype: "message_changed" }, { channel: undefined }, { ts: undefined },
  ]) await run(event);
  assert.ok(Object.values(calls).every((values) => values.length === 0));
});

test("uses the event timestamp as the root thread and a deterministic fallback event key", async () => {
  const { calls, run } = setup();
  await run({ thread_ts: undefined }, {});
  assert.deepEqual(calls.claim, [["C123", "1700000002.000001", "C123:1700000002.000001"]]);
  assert.equal(calls.post[0][0].thread_ts, "1700000002.000001");
});

test("publishes every Unicode character of a long answer in numbered chunks", async () => {
  const answer = "日本語😊と英語ABC。".repeat(850);
  const { calls, run } = setup({ answer });
  await run();
  const posts = calls.post.map(([message]) => message);
  assert.ok(posts.length > 2);
  const content = posts.map((message, index) => {
    const prefix = `_Fable 5.1で回答 (${index + 1}/${posts.length})_\n`;
    assert.ok(message.text.startsWith(prefix));
    assert.equal(message.unfurl_links, false);
    assert.equal(message.unfurl_media, false);
    const text = message.text.slice(prefix.length);
    assert.ok(Array.from(text).length <= 3500);
    assert.ok(text.isWellFormed());
    return text;
  });
  assert.equal(content.join(""), answer);
  assert.equal(calls.save[0][2].answer, answer);
  assert.deepEqual(splitSlackAnswer("a😊b🚀", 2), ["a😊", "b🚀"]);
});

test("keeps native Slack citation links whole when they cross a Unicode chunk boundary", () => {
  const citation = "<https://example.com/report|出典😊>";
  const answer = `${"😊".repeat(3495)}${citation}後続の説明`;
  const parts = splitSlackAnswer(answer);
  assert.equal(parts.join(""), answer);
  assert.ok(parts.every((part) => part.isWellFormed() && Array.from(part).length <= 3500));
  assert.equal(parts.filter((part) => part.includes(citation)).length, 1);
  assert.ok(parts.every((part) => !part.includes("<https://") || part.includes(citation)));
});

test("prefers a paragraph boundary without dropping its separators", () => {
  const paragraph = "最初の段落です。\n\n";
  const answer = paragraph + "続きの段落😊".repeat(800);
  const parts = splitSlackAnswer(answer);
  assert.equal(parts.join(""), answer);
  assert.equal(parts[0], paragraph);
  assert.ok(parts.every((part) => Array.from(part).length <= 3500));
});

test("closes and reopens fenced code on complete lines while retaining its language", () => {
  const lines = Array.from({ length: 9 }, (_, index) => `const n${index} = "😊";`);
  const answer = `説明\n\`\`\`javascript\n${lines.join("\n")}\n\`\`\`\n完了`;
  const parts = splitSlackAnswer(answer, 50);
  const codeParts = parts.filter((part) => part.includes("```"));
  assert.ok(parts.length > 2);
  assert.ok(parts[0].startsWith("説明\n```javascript\n"));
  assert.ok(codeParts.slice(1).every((part) => part.startsWith("```javascript\n")));
  assert.ok(parts.at(-1).endsWith("完了"));
  for (const part of parts) {
    assert.equal((part.match(/```/g) || []).length % 2, 0);
    assert.ok(Array.from(part).length <= 50);
    assert.ok(part.isWellFormed());
    for (const line of part.split("\n").filter((value) => value.startsWith("const"))) {
      assert.ok(lines.includes(line), "code lines should stay whole when they fit");
    }
  }
  for (const line of lines) assert.equal(parts.join("\n").split(line).length - 1, 1);
});

test("splits a long code line without breaking Unicode or native Slack links", () => {
  const citation = "<https://example.com/source|出典😊>";
  const code = `${"😊".repeat(70)}${citation}${"🚀".repeat(70)}`;
  const parts = splitSlackAnswer(`\`\`\`\n${code}\n\`\`\``, 60);
  assert.ok(parts.length > 2);
  assert.ok(parts.every((part) => part.startsWith("```\n") && part.endsWith("\n```")));
  assert.ok(parts.every((part) => part.isWellFormed() && Array.from(part).length <= 60));
  assert.equal(parts.map((part) => part.slice(4, -4)).join(""), code);
  assert.equal(parts.filter((part) => part.includes(citation)).length, 1);
});

test("leaves a complete short fenced answer unchanged and closes an unfinished fence", () => {
  const answer = "前置き\n```js\nconst value = 1;\n```\n結論";
  assert.deepEqual(splitSlackAnswer(answer), [answer]);
  assert.deepEqual(splitSlackAnswer("```js\nconst value = 1;"), ["```js\nconst value = 1;\n```"]);
});

test("falls back to a line boundary without adding characters outside fenced code", () => {
  const answer = "最初の行\n" + "次の長い行です😊".repeat(10);
  const parts = splitSlackAnswer(answer, 20);
  assert.equal(parts[0], "最初の行\n");
  assert.equal(parts.join(""), answer);
  assert.ok(parts.every((part) => Array.from(part).length <= 20));
});

test("reserves Slack header space even with large requested chunks and atomic links", () => {
  const parts = splitSlackAnswer("😊".repeat(40_000), 100_000);
  assert.deepEqual(parts.map((part) => Array.from(part).length), [39_000, 1_000]);
  const citation = `<https://example.com/${"a".repeat(38_950)}|出典>`;
  const fenced = splitSlackAnswer(`\`\`\`\n${citation}\n\`\`\``);
  assert.ok(fenced.every((part) => Array.from(part).length <= 39_000));
  assert.equal(fenced.filter((part) => part.includes(citation)).length, 1);
  assert.ok(fenced.every((part) => (part.match(/```/g) || []).length % 2 === 0));
});

test("publishes balanced code chunks while storing the original answer unchanged", async () => {
  const lines = Array.from({ length: 350 }, (_, index) => `const item${index} = "日本語😊";`);
  const answer = `\`\`\`js\n${lines.join("\n")}\n\`\`\``;
  const { calls, run } = setup({ answer });
  await run();
  assert.equal(calls.save[0][2].answer, answer);
  assert.ok(calls.post.length > 1);
  for (const [message] of calls.post) {
    assert.ok(message.text.includes("```js\n"));
    assert.equal((message.text.match(/```/g) || []).length, 2);
    assert.ok(Array.from(message.text).length < 40_000);
  }
  assert.equal(calls.finish[0][3], "completed");
});

test("marks unsupported or empty user input failed and returns the actionable explanation", async () => {
  for (const [text, expected] of [
    ["<@UCLAUDE> image 猫", /画像生成に対応していません/],
    ["<@UCLAUDE>", /画像・PDFを添付/],
  ]) {
    const { calls, run } = setup();
    await run({ text });
    assert.equal(calls.respond.length, 0);
    assert.equal(calls.save.length, 0);
    assert.match(calls.post[0][0].text, expected);
    assert.equal(calls.finish[0][3], "failed");
  }
});

test("shows safe attachment validation errors without logging their credential-bearing causes", async () => {
  const secret = "sk-ant-test-secret-never-publish";
  const inputError = new SlackInputError("ファイルを再添付してください。", { cause: new Error(secret) });
  const { calls, run } = setup({ inputError });
  await run();
  assert.equal(calls.post[0][0].text, inputError.message);
  assert.equal(calls.finish[0][3], "failed");
  assert.doesNotMatch(JSON.stringify(calls.logs), new RegExp(secret));
});

test("API failures never expose API keys, Slack tokens, or the raw error in replies and logs", async () => {
  const responseError = Object.assign(new Error("Authorization: Bearer sk-ant-test-secret; Slack xoxb-test-secret"), {
    name: "APIError", status: 401, code: "authentication_error",
  });
  const { calls, run } = setup({ responseError });
  await run();
  assert.equal(calls.save.length, 0);
  assert.equal(calls.finish[0][3], "failed");
  assert.match(calls.post[0][0].text, /Claudeの処理に失敗/);
  assert.doesNotMatch(JSON.stringify({ posts: calls.post, logs: calls.logs }), /sk-ant-test-secret|xoxb-test-secret|Authorization/);
  assert.ok(calls.logs.some(({ args }) => args[1]?.status === 401));
});

test("does not publish an answer if saving shared history fails", async () => {
  const { calls, sequence, run } = setup({
    answer: "まだ保存されていない回答",
    saveTurn: async () => { throw new Error("Firestore unavailable"); },
  });
  await run();
  assert.equal(calls.save.length, 1);
  assert.equal(calls.post.length, 1);
  assert.doesNotMatch(calls.post[0][0].text, /まだ保存されていない回答/);
  assert.equal(calls.finish[0][3], "failed");
  assert.ok(sequence.indexOf("save") < sequence.indexOf("post"));
});

test("records failed delivery while retaining the answer already committed to shared history", async () => {
  let attempted = 0;
  const { calls, run } = setup({ postMessage: async () => {
    attempted += 1;
    if (attempted === 1) throw new Error("Slack unavailable");
  } });
  await run();
  assert.equal(calls.save.length, 1);
  assert.deepEqual(calls.finish.map((args) => args[3]), ["failed"]);
  assert.equal(calls.post.length, 2);
  assert.match(calls.post[1][0].text, /Claudeの処理に失敗/);
});

test("never sends an extra error reply after publishing when the completion write fails", async () => {
  let attempts = 0;
  const { calls, run } = setup({ finishEvent: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary status write failure");
  } });
  await run();
  assert.equal(calls.post.length, 1);
  assert.deepEqual(calls.finish.map((args) => args[3]), ["completed", "completed"]);
});

test("still posts a safe error reply when recording the failed status also fails", async () => {
  const { calls, run } = setup({
    responseError: new Error("sk-ant-request-secret"),
    finishEvent: async () => { throw new Error("sk-ant-status-secret"); },
  });
  await run();
  assert.equal(calls.post.length, 1);
  assert.match(calls.post[0][0].text, /Claudeの処理に失敗/);
  assert.doesNotMatch(JSON.stringify(calls.logs), /sk-ant-request-secret|sk-ant-status-secret/);
});

test("acknowledgement errors do not prevent an answer and already_reacted needs no warning", async () => {
  for (const code of ["already_reacted", "missing_scope"]) {
    const { calls, run } = setup({ reactionError: { data: { error: code } } });
    await run();
    assert.equal(calls.respond.length, 1);
    assert.equal(calls.finish[0][3], "completed");
    assert.equal(calls.logs.filter(({ level }) => level === "warn").length, code === "already_reacted" ? 0 : 1);
  }
});
