import assert from "node:assert/strict";
import test from "node:test";
import { createSlackPoster } from "../src/slack-output.mjs";

function setup(post) {
  let time = 0;
  const sleeps = [];
  const starts = [];
  const client = { chat: { async postMessage(options) {
    starts.push({ time, options });
    return post ? post(options, starts.length) : { ok: true, ts: String(starts.length) };
  } } };
  const poster = createSlackPoster({
    now: () => time,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); time += milliseconds; },
  });
  return { poster, client, starts, sleeps, advance: (milliseconds) => { time += milliseconds; } };
}

function rateLimit(retryAfter) {
  return Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter });
}

test("paces consecutive chunks at least one second apart and preserves message options", async () => {
  const { poster, client, starts } = setup();
  const options = { channel: "C1", thread_ts: "1.1", text: "first", unfurl_links: false };
  const result = await poster(client, options);
  await poster(client, { ...options, text: "second" });
  await poster(client, { ...options, text: "third" });

  assert.deepEqual(result, { ok: true, ts: "1" });
  assert.deepEqual(starts.map(({ time }) => time), [0, 1000, 2000]);
  assert.equal(starts[0].options, options);
});

test("serializes concurrent sends in one channel while allowing another channel to start immediately", async () => {
  const { poster, client, starts } = setup();
  await Promise.all([
    poster(client, { channel: "C1", text: "first" }),
    poster(client, { channel: "C1", text: "second" }),
    poster(client, { channel: "C2", text: "independent" }),
    poster(client, { channel: "C1", text: "third" }),
  ]);

  assert.deepEqual(starts.filter(({ options }) => options.channel === "C1").map(({ time }) => time), [0, 1000, 2000]);
  assert.equal(starts.find(({ options }) => options.channel === "C2").time, 0);
});

test("honors Retry-After before retrying exactly the rejected message", async () => {
  const { poster, client, starts, sleeps } = setup((_options, call) => {
    if (call === 1) throw rateLimit(3);
    return { ok: true };
  });
  const options = { channel: "C1", text: "retry this message" };
  assert.deepEqual(await poster(client, options), { ok: true });
  assert.deepEqual(starts.map(({ time }) => time), [0, 3000]);
  assert.deepEqual(sleeps, [3000]);
  assert.ok(starts.every((entry) => entry.options === options));
});

test("zero Retry-After still respects channel pacing and repeated 429s are bounded", async () => {
  const { poster, client, starts } = setup(() => { throw rateLimit(0); });
  await assert.rejects(poster(client, { channel: "C1", text: "limited" }), { code: "slack_posting_retry_limit" });
  assert.deepEqual(starts.map(({ time }) => time), [0, 1000, 2000, 3000]);
});

test("rejects Retry-After beyond the sixty-second budget without an early retry", async () => {
  const { poster, client, starts, sleeps } = setup(() => { throw rateLimit(65); });
  await assert.rejects(poster(client, { channel: "C1", text: "limited" }), { code: "slack_posting_deadline" });
  assert.equal(starts.length, 1);
  assert.deepEqual(sleeps, []);
});

test("counts accumulated waits and queue time toward each message's deadline", async () => {
  const { poster, client, starts, sleeps } = setup(() => { throw rateLimit(31); });
  const results = await Promise.allSettled([
    poster(client, { channel: "C1", text: "first" }),
    poster(client, { channel: "C1", text: "queued" }),
  ]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.code === "slack_posting_deadline"));
  assert.deepEqual(starts.map(({ time }) => time), [0, 31000]);
  assert.deepEqual(sleeps, [31000]);
});

test("shares Retry-After cooldown across channels on the same app", async () => {
  const { poster, client, starts, advance } = setup((_options, call) => {
    if (call === 1) throw rateLimit(65);
    return { ok: true };
  });
  await assert.rejects(poster(client, { channel: "C1", text: "limited" }), { code: "slack_posting_deadline" });
  advance(10_000);
  await poster(client, { channel: "C2", text: "another channel" });
  assert.deepEqual(starts.map(({ time }) => time), [0, 65000]);
});

test("does not retry unknown HTTP, network, or platform failures and does not poison the queue", async () => {
  const failure = Object.assign(new Error("connection reset after delivery"), { code: "slack_webapi_request_error" });
  const { poster, client, starts } = setup((_options, call) => {
    if (call === 1) throw failure;
    return { ok: true };
  });
  const first = poster(client, { channel: "C1", text: "first" });
  const second = poster(client, { channel: "C1", text: "next" });
  await assert.rejects(first, (error) => error === failure);
  await second;
  assert.deepEqual(starts.map(({ options }) => options.text), ["first", "next"]);
  assert.deepEqual(starts.map(({ time }) => time), [0, 1000]);
});

test("rejects malformed Retry-After without guessing or repeating the request", async () => {
  for (const value of [undefined, NaN, Infinity, -1, "3"]) {
    const failure = rateLimit(value);
    const { poster, client, starts } = setup(() => { throw failure; });
    await assert.rejects(poster(client, { channel: "C1", text: "message" }), (error) => error === failure);
    assert.equal(starts.length, 1);
  }
});

test("rejects missing channel identifiers before attempting to send", async () => {
  const { poster, client, starts } = setup();
  await assert.rejects(poster(client, { text: "message" }), /channel is required/);
  assert.equal(starts.length, 0);
});
