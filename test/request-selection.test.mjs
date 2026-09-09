import assert from "node:assert/strict";
import test from "node:test";
import { selectRequest } from "../src/request-selection.mjs";

test("keeps ordinary text as the prompt", () => {
  const selection = selectRequest("今日の会議を要約して");

  assert.equal(selection.prompt, "今日の会議を要約して");
  assert.equal(selection.forceImageGeneration, false);
});

test("recognizes the image command without storing model selection", () => {
  const selection = selectRequest("image 雨上がりの東京");

  assert.equal(selection.prompt, "雨上がりの東京");
  assert.equal(selection.forceImageGeneration, true);
  assert.equal("model" in selection, false);
  assert.equal("label" in selection, false);
});
