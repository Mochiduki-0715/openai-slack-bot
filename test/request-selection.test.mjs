import assert from "node:assert/strict";
import test from "node:test";
import { modelLabel, selectRequest } from "../src/request-selection.mjs";

test("uses the configured model without parsing a model command", () => {
  const selection = selectRequest("terra 今日の会議を要約して", "gpt-5.6-sol");

  assert.equal(selection.model, "gpt-5.6-sol");
  assert.equal(selection.label, "Sol");
  assert.equal(selection.prompt, "terra 今日の会議を要約して");
  assert.equal(selection.forceImageGeneration, false);
});

test("keeps the image command independent from model selection", () => {
  const selection = selectRequest("image 雨上がりの東京", "gpt-5.6-sol");

  assert.equal(selection.model, "gpt-5.6-sol");
  assert.equal(selection.prompt, "雨上がりの東京");
  assert.equal(selection.forceImageGeneration, true);
});

test("labels supported operational model overrides", () => {
  assert.equal(modelLabel("gpt-5.6-sol"), "Sol");
  assert.equal(modelLabel("gpt-5.6-terra"), "Terra");
  assert.equal(modelLabel("gpt-5.6-luna"), "Luna");
});
