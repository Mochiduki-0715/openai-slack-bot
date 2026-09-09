import assert from "node:assert/strict";
import test from "node:test";
import { SlackInputError, slackFileInputs, validatePrompt } from "../src/slack-input.mjs";

const maxAttachmentBytes = 20 * 1024 * 1024;
const token = "test-only-bot-token";
const png = {
  id: "F1",
  name: "picture.png",
  mimetype: "image/png",
  size: 3,
  url_private_download: "https://files.slack.com/files-pri/T1-F1/picture.png",
};

function setup(metadata = [png]) {
  const calls = [];
  return {
    calls,
    client: { files: { info: async (input) => {
      calls.push(input);
      return { ok: true, file: metadata.find((file) => file.id === input.file) };
    } } },
    event: { files: metadata.map(({ id }) => ({ id })) },
  };
}

function rejectsInput(promise, pattern) {
  return assert.rejects(promise, (error) => error instanceof SlackInputError && pattern.test(error.message));
}

test("validates prompts without blocking discussion of YouTube or images", () => {
  assert.equal(validatePrompt("  YouTubeの収益モデルを教えて  "), "YouTubeの収益モデルを教えて");
  assert.equal(validatePrompt("https://www.youtube.com/@channel"), "https://www.youtube.com/@channel");
  assert.equal(validatePrompt("https://www.youtube.com/"), "https://www.youtube.com/");
  assert.equal(validatePrompt("https://example.com/youtube.com/watch?v=abc"), "https://example.com/youtube.com/watch?v=abc");
  assert.equal(validatePrompt("https://not.youtube.com/watch?v=abc"), "https://not.youtube.com/watch?v=abc");
  assert.equal(validatePrompt("画像の説明をして"), "画像の説明をして");
  assert.equal(validatePrompt(), "");
  assert.throws(() => validatePrompt(" IMAGE 猫"), /画像生成に対応していません/);
});

test("rejects explicit YouTube video URLs including Slack link syntax", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abcdef",
    "<https://youtu.be/abcdef|こちらを要約>",
    "https://m.youtube.com/shorts/abcdef",
    "youtube.com/live/abcdef",
    "https://www.youtube-nocookie.com/embed/abcdef",
  ]) {
    assert.throws(() => validatePrompt(`要約して ${url}`), (error) => error instanceof SlackInputError && /YouTube動画/.test(error.message));
  }
});

test("returns no input blocks for a message without files or a configured token", async () => {
  assert.deepEqual(await slackFileInputs(null, {}, { token: "" }), []);
});

test("resolves Slack metadata and sends credentials only to the trusted download URL", async () => {
  const { client, event, calls } = setup();
  const fetchCalls = [];
  const result = await slackFileInputs(client, event, { token, fetchImpl: async (...args) => {
    fetchCalls.push(args);
    return new Response("png", { headers: { "content-type": "image/png" } });
  } });
  assert.deepEqual(calls, [{ file: "F1" }]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], png.url_private_download);
  const { signal, ...fetchOptions } = fetchCalls[0][1];
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(signal.aborted, false);
  assert.deepEqual(fetchOptions, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error",
  });
  assert.deepEqual(result, [{ type: "input_image", image_url: "data:image/png;base64,cG5n" }]);
});

test("accepts supported image types and PDF and uses url_private as a fallback", async () => {
  const metadata = ["image/jpeg", "image/gif", "image/webp", "application/pdf"].map((mimetype, index) => ({
    id: `F${index}`, mimetype, name: `file-${index}`, size: 3,
    url_private: `https://files.slack.com/files-pri/T1-F${index}/file`,
  }));
  const { client, event } = setup(metadata);
  const result = await slackFileInputs(client, event, { token, fetchImpl: async () => new Response("abc") });
  assert.deepEqual(result, [
    { type: "input_image", image_url: "data:image/jpeg;base64,YWJj" },
    { type: "input_image", image_url: "data:image/gif;base64,YWJj" },
    { type: "input_image", image_url: "data:image/webp;base64,YWJj" },
    { type: "input_file", filename: "file-3", file_data: "data:application/pdf;base64,YWJj" },
  ]);
});

test("rejects unsupported attachments before downloading", async () => {
  for (const mimetype of ["audio/mp3", "video/mp4", "image/svg+xml", "text/plain"]) {
    const { client, event } = setup([{ ...png, mimetype }]);
    await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: () => assert.fail("must not download") }), /JPEG.*PDF/);
  }
});

test("reports missing metadata, file ID, private URL, and token clearly", async () => {
  const { client, event } = setup();
  await rejectsInput(slackFileInputs(client, event, { token: "" }), /Slack認証/);
  await rejectsInput(slackFileInputs(client, { files: [{}] }, { token }), /ID/);
  await rejectsInput(slackFileInputs(client, { files: [{ id: "missing" }] }, { token }), /ファイル情報/);
  await rejectsInput(slackFileInputs(client, { files: "invalid" }, { token }), /ファイル情報/);
  const missingUrl = setup([{ ...png, url_private_download: undefined }]);
  await rejectsInput(slackFileInputs(missingUrl.client, missingUrl.event, { token }), /ダウンロードURL/);
});

test("reports Slack files.info errors without exposing internal error text", async () => {
  const client = { files: { info: async () => { throw new Error("secret-detail"); } } };
  await assert.rejects(slackFileInputs(client, { files: [{ id: "F1" }] }, { token }), (error) => {
    assert.equal(error instanceof SlackInputError, true);
    assert.match(error.message, /閲覧権限/);
    assert.equal(error.message.includes("secret-detail"), false);
    return true;
  });
});

test("rejects untrusted URL schemes, hosts, credentials, and ports without sending credentials", async () => {
  for (const url_private_download of [
    "http://files.slack.com/file",
    "https://files.slack.com.evil.example/file",
    "https://evilslack.com/file",
    "https://slack.com/file",
    "https://user:pass@files.slack.com/file",
    "https://files.slack.com:8443/file",
    "file:///tmp/private",
    "not-a-url",
  ]) {
    const { client, event } = setup([{ ...png, url_private_download }]);
    await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: () => assert.fail("must not download") }), /URL/);
  }
});

test("rejects a redirect and does not follow the destination", async () => {
  const { client, event } = setup();
  let fetchCount = 0;
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async (_, options) => {
    fetchCount += 1;
    assert.equal(options.redirect, "error");
    return new Response(null, { status: 302, headers: { location: "https://evil.example/file" } });
  } }), /HTTP 302/);
  assert.equal(fetchCount, 1);
});

test("rejects total declared size over 20 MiB before any file download", async () => {
  const { client, event } = setup([
    { ...png, size: maxAttachmentBytes / 2 },
    { ...png, id: "F2", size: maxAttachmentBytes / 2 + 1 },
  ]);
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: () => assert.fail("must not download") }), /合計20MiB/);
});

test("rejects an oversized content-length and cancels the body before reading", async () => {
  const { client, event } = setup();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "content-length": String(maxAttachmentBytes + 1) },
  });
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async () => response }), /合計20MiB/);
  assert.equal(cancelled, true);
});

test("bounds actual streamed bytes even when metadata and headers understate size", async () => {
  const { client, event } = setup();
  let cancelled = false;
  let sent = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const response = new Response(new ReadableStream({
    pull(controller) { sent += 1; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "1" } });
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async () => response }), /合計20MiB/);
  assert.equal(cancelled, true);
  assert.ok(sent <= 22, "must stop reading as soon as the limit is exceeded");
});

test("tracks actual bytes across files and allows exactly 20 MiB", async () => {
  const { client, event } = setup([{ ...png, size: 1 }, { ...png, id: "F2", size: 1 }]);
  let index = 0;
  const result = await slackFileInputs(client, event, { token, fetchImpl: async () => {
    index += 1;
    return new Response(new Uint8Array(index === 1 ? maxAttachmentBytes - 1 : 1));
  } });
  assert.equal(result.length, 2);
  index = 0;
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async () => {
    index += 1;
    return new Response(new Uint8Array(index === 1 ? maxAttachmentBytes : 1));
  } }), /合計20MiB/);
});

test("reports failed HTTP requests, network errors, empty files, and body read errors", async () => {
  const { client, event } = setup();
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async () => new Response("forbidden", { status: 403 }) }), /HTTP 403/);
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async () => { throw new Error("network details"); } }), /ダウンロードできません/);
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async () => new Response("") }), /空です/);
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("read failed")); } }));
  await rejectsInput(slackFileInputs(client, event, { token, fetchImpl: async () => broken }), /ダウンロードできません/);
});

test("aborts a stalled HTTP request when the shared download deadline expires", async () => {
  const { client, event } = setup();
  let signal;
  await rejectsInput(slackFileInputs(client, event, {
    token, downloadTimeoutMs: 5,
    fetchImpl: (_, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }), /制限時間/);
  assert.equal(signal.aborted, true);
});

test("cancels a stalled response body and shares one deadline signal across downloads", async () => {
  const { client, event } = setup([png, { ...png, id: "F2" }]);
  const signals = [];
  let cancelled = false;
  await rejectsInput(slackFileInputs(client, event, {
    token, downloadTimeoutMs: 5,
    fetchImpl: async (_, { signal }) => {
      signals.push(signal);
      if (signals.length === 1) return new Response("abc");
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    },
  }), /制限時間/);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(cancelled, true);
});

test("clears the deadline timer after a successful download", async () => {
  const { client, event } = setup();
  let signal;
  await slackFileInputs(client, event, {
    token, downloadTimeoutMs: 5,
    fetchImpl: async (_, options) => { signal = options.signal; return new Response("abc"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signal.aborted, false);
});
