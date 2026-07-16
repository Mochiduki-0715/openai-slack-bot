import assert from "node:assert/strict";
import test from "node:test";
import {
  consumesMediaQuota,
  extractYouTubeUrls,
  isYouTubeHost,
  japanUsageKeys,
  mediaKindForMimeType,
} from "../src/media-jobs.mjs";

test("classifies supported Slack media MIME types", () => {
  assert.equal(mediaKindForMimeType("application/pdf"), "pdf");
  assert.equal(mediaKindForMimeType("audio/m4a"), "audio");
  assert.equal(mediaKindForMimeType("video/mp4"), "video");
  assert.equal(mediaKindForMimeType("image/png"), null);
});

test("extracts only YouTube URLs from Slack formatted text", () => {
  assert.deepEqual(
    extractYouTubeUrls("<https://youtu.be/abc123|demo> and https://example.com/movie"),
    ["https://youtu.be/abc123"],
  );
  assert.equal(isYouTubeHost("www.youtube.com"), true);
  assert.equal(isYouTubeHost("youtube.example.com"), false);
});

test("uses Asia/Tokyo dates for quota documents", () => {
  assert.deepEqual(japanUsageKeys(new Date("2026-07-16T14:59:59.000Z")), {
    day: "2026-07-16",
    month: "2026-07",
  });
  assert.deepEqual(japanUsageKeys(new Date("2026-07-16T15:00:00.000Z")), {
    day: "2026-07-17",
    month: "2026-07",
  });
});

test("only audio, video, and YouTube jobs consume quota", () => {
  assert.equal(consumesMediaQuota([{ kind: "pdf" }]), false);
  assert.equal(consumesMediaQuota([{ kind: "pdf" }, { kind: "video" }]), true);
});
