import assert from "node:assert/strict";
import test from "node:test";
import { fetchOpenAICosts, monthlyUsageMessage, previousMonthRange } from "../src/monthly-usage.mjs";

test("previousMonthRange uses the previous calendar month in Tokyo", () => {
  const range = previousMonthRange(new Date("2026-07-01T00:00:00+09:00"));
  assert.deepEqual(range, {
    yearMonth: "2026-06",
    startTime: Math.floor(new Date("2026-06-01T00:00:00+09:00").getTime() / 1000),
    endTime: Math.floor(new Date("2026-07-01T00:00:00+09:00").getTime() / 1000),
  });
});

test("fetchOpenAICosts sums paginated buckets for one project", async () => {
  const urls = [];
  const pages = [
    { data: [{ results: [{ amount: { value: 1.25, currency: "usd" } }] }], has_more: true, next_page: "next" },
    { data: [{ results: [{ amount: { value: 2.5, currency: "usd" } }] }], has_more: false },
  ];
  const usage = await fetchOpenAICosts({
    apiKey: "test",
    startTime: 1,
    endTime: 2,
    projectId: "proj_test",
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return new Response(JSON.stringify(pages.shift()), { status: 200 });
    },
  });
  assert.deepEqual(usage, { amount: 3.75, currency: "usd" });
  assert.equal(urls[0].searchParams.get("project_ids"), "proj_test");
  assert.equal(urls[1].searchParams.get("page"), "next");
});

test("monthlyUsageMessage only includes the previous month's amount", () => {
  assert.equal(monthlyUsageMessage({ amount: 12.5, currency: "usd" }), "*OpenAI API 利用状況*\n前月の利用額: $12.50");
});
