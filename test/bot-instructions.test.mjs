import assert from "node:assert/strict";
import test from "node:test";
import { politeToneInstruction } from "../src/bot-instructions.mjs";

test("configures polite Japanese responses by default", () => {
  assert.match(politeToneInstruction, /polite, respectful tone/i);
  assert.match(politeToneInstruction, /Japanese.*です・ます調/i);
  assert.match(politeToneInstruction, /unless the user explicitly requests a different tone/i);
});
