import assert from "node:assert/strict";
import test from "node:test";
import { createConversationStore } from "../src/conversations.mjs";

function mockFirestore() {
  const data = new Map();
  const commits = [];
  let transactionQueue = Promise.resolve();
  let failNextCommit = false;

  function document(path) {
    return {
      path,
      collection: (name) => collection(`${path}/${name}`),
      async update(fields) {
        assert.ok(data.has(path), "cannot finish an event that was not claimed");
        data.set(path, { ...data.get(path), ...structuredClone(fields) });
      },
    };
  }

  function collection(path) {
    return {
      doc: (name) => document(`${path}/${name}`),
      orderBy(field, order) {
        assert.equal(field, "createdAt");
        assert.equal(order, "asc");
        return { async get() {
          const records = [...data.entries()]
            .filter(([key]) => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1)
            .map(([, record]) => record)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return { docs: records.map((record) => ({ data: () => structuredClone(record) })) };
        } };
      },
    };
  }

  const firestore = {
    collection,
    runTransaction(callback) {
      const result = transactionQueue.then(async () => {
        const pending = [];
        const result = await callback({
          async get(reference) {
            assert.equal(pending.length, 0, "all transaction reads must precede writes");
            return { exists: data.has(reference.path), data: () => structuredClone(data.get(reference.path)) };
          },
          set(reference, value) { pending.push({ path: reference.path, value: structuredClone(value) }); },
        });
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error("commit failed");
        }
        for (const { path, value } of pending) data.set(path, value);
        commits.push(pending);
        return result;
      });
      transactionQueue = result.catch(() => {});
      return result;
    },
  };
  return { firestore, data, commits, failNextCommit: () => { failNextCommit = true; } };
}

const base = "slack_conversations/C1/threads/1000.0001";
const prefix = "[Claude（Fable 5.1）の回答]\n";

test("reads the existing GPT schema and later Claude replies in chronological shared history", async () => {
  const { firestore, data } = mockFirestore();
  data.set(`${base}/messages/gpt-user`, { role: "user", content: "GPTへの質問", createdAt: new Date(100) });
  data.set(`${base}/messages/gpt-assistant`, { role: "assistant", content: "Astraの回答", createdAt: new Date(101) });
  data.set(`${base}/messages/old-claude-assistant`, { role: "assistant", content: `${prefix}以前のClaude回答`, provider: "claude", model: "claude-fable-5-1", createdAt: new Date(103) });
  const store = createConversationStore(firestore);

  assert.deepEqual(await store.history("C1", "1000.0001"), [
    { role: "user", content: "GPTへの質問" },
    { role: "assistant", content: "Astraの回答" },
    { role: "assistant", content: `${prefix}以前のClaude回答` },
  ]);
  await store.saveTurn("C1", "1000.0001", { eventKey: "Ev1", prompt: "回答を比較して", answer: "比較結果です。" });
  const history = await store.history("C1", "1000.0001");
  assert.deepEqual(history.slice(-2), [
    { role: "user", content: "回答を比較して" },
    { role: "assistant", content: `${prefix}比較結果です。` },
  ]);
  // GPT's unchanged reader accepts exactly these role/content string fields.
  const snapshot = await firestore.collection("slack_conversations").doc("C1")
    .collection("threads").doc("1000.0001").collection("messages").orderBy("createdAt", "asc").get();
  const gptHistory = snapshot.docs.map((record) => record.data())
    .filter((message) => ["user", "assistant"].includes(message.role) && typeof message.content === "string")
    .map(({ role, content }) => ({ role, content }));
  assert.deepEqual(gptHistory, history);
  assert.equal(data.get(`${base}/messages/gpt-assistant`).content, "Astraの回答");
});

test("isolates channels, threads, custom collections, and non-message data", async () => {
  const { firestore, data } = mockFirestore();
  const store = createConversationStore(firestore);
  await store.saveTurn("C1", "1000.0001", { eventKey: "Ev1", prompt: "shared thread", answer: "one" });
  await store.saveTurn("C2", "1000.0001", { eventKey: "Ev1", prompt: "another channel", answer: "two" });
  await store.saveTurn("C1", "2000.0001", { eventKey: "Ev1", prompt: "another thread", answer: "three" });
  const custom = createConversationStore(firestore, { collection: "test_conversations" });
  await custom.saveTurn("C1", "1000.0001", { eventKey: "Ev1", prompt: "test only", answer: "four" });
  data.set(`${base}/messages/invalid-blocks`, { role: "user", content: [{ type: "image", data: "base64" }], createdAt: new Date(1) });
  data.set(`${base}/messages/invalid-role`, { role: "system", content: "ignored", createdAt: new Date(2) });
  await store.claimEvent("C1", "1000.0001", "Ev1");

  assert.equal((await store.history("C1", "1000.0001")).length, 2);
  assert.equal((await store.history("C1", "1000.0001"))[0].content, "shared thread");
  assert.equal((await store.history("C2", "1000.0001"))[0].content, "another channel");
  assert.equal((await store.history("C1", "2000.0001"))[0].content, "another thread");
  assert.equal((await custom.history("C1", "1000.0001"))[0].content, "test only");
  assert.deepEqual(await store.history("C3", "1000.0001"), []);
});

test("claims concurrent duplicate Claude events exactly once without locking GPT history", async () => {
  const { firestore, data } = mockFirestore();
  const store = createConversationStore(firestore);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.claimEvent("C1", "1000.0001", "Ev1")));

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(data.size, 1);
  const [[path, event]] = data;
  assert.match(path, new RegExp(`^${base.replaceAll(".", "\\.")}/claude_events/[a-f0-9]{64}$`));
  assert.equal(event.status, "processing");
  assert.equal(await store.claimEvent("C1", "1000.0001", "Ev2"), true);
  assert.equal(await store.claimEvent("C2", "1000.0001", "Ev1"), true);
  assert.equal(await store.claimEvent("C1", "2000.0001", "Ev1"), true);
  assert.deepEqual(await store.history("C1", "1000.0001"), []);
});

test("finishes success and failure statuses without making duplicate events claimable again", async () => {
  const { firestore, data } = mockFirestore();
  const store = createConversationStore(firestore);
  for (const status of ["completed", "failed"]) {
    const eventKey = `Ev-${status}`;
    assert.equal(await store.claimEvent("C1", "1000.0001", eventKey), true);
    await store.finishEvent("C1", "1000.0001", eventKey, status);
    assert.equal(await store.claimEvent("C1", "1000.0001", eventKey), false);
    assert.ok([...data.values()].some((event) => event.status === status && event.updatedAt instanceof Date));
  }
});

test("saves both messages atomically and keeps retries idempotent including timestamps", async () => {
  const { firestore, data, commits } = mockFirestore();
  const store = createConversationStore(firestore);
  const turn = { eventKey: "Ev/with/slashes", prompt: "plain prompt", answer: "analysis only" };
  await store.saveTurn("C1", "1000.0001", turn);
  const original = structuredClone(data);
  await Promise.all([
    store.saveTurn("C1", "1000.0001", turn),
    store.saveTurn("C1", "1000.0001", { ...turn, answer: "different retry" }),
  ]);

  assert.deepEqual(data, original);
  assert.equal(data.size, 2);
  assert.equal(commits[0].length, 2);
  assert.ok(commits.slice(1).every((writes) => writes.length === 0));
  const records = [...data.values()].sort((a, b) => a.createdAt - b.createdAt);
  assert.equal(records[0].role, "user");
  assert.equal(records[1].role, "assistant");
  assert.equal(records[1].createdAt.getTime() - records[0].createdAt.getTime(), 1);
  assert.ok(records.every((message) => message.provider === "claude" && message.model === "claude-fable-5-1"));
  assert.ok([...data.keys()].every((path) => /\/messages\/claude_[a-f0-9]{64}_(user|assistant)$/.test(path)));
});

test("a failed transaction leaves neither a user nor an assistant message", async () => {
  const { firestore, data, failNextCommit } = mockFirestore();
  const store = createConversationStore(firestore);
  failNextCommit();

  await assert.rejects(store.saveTurn("C1", "1000.0001", { eventKey: "Ev1", prompt: "question", answer: "answer" }), /commit failed/);
  assert.equal(data.size, 0);
});

test("validates scope and stores only string conversation text", async () => {
  const { firestore, data } = mockFirestore();
  const store = createConversationStore(firestore);
  await assert.rejects(store.history("C1/other", "1000.0001"), /channel/);
  await assert.rejects(store.history("C1", "1000.0001/other"), /threadTs/);
  await assert.rejects(store.claimEvent("C1", "1000.0001", ""), /eventKey/);
  await assert.rejects(store.saveTurn("C1", "1000.0001", { eventKey: "Ev1", prompt: [{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }], answer: "answer" }), /must be strings/);
  assert.equal(data.size, 0);
  await store.saveTurn("C1", "1000.0001", { eventKey: "Ev1", prompt: "[添付PDF: 資料.pdf]", answer: `${prefix}既に識別済みの回答` });
  assert.equal((await store.history("C1", "1000.0001"))[1].content, `${prefix}既に識別済みの回答`);
});
