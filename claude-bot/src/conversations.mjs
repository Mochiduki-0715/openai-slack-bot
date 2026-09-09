import { createHash } from "node:crypto";
import { claudeModel, claudeModelLabel } from "./model.mjs";

const answerPrefix = `[Claude（${claudeModelLabel}）の回答]\n`;

function documentSegment(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("/")) {
    throw new TypeError(`${name} must be a nonempty Firestore document ID.`);
  }
  return value;
}

function eventId(eventKey) {
  if (typeof eventKey !== "string" || !eventKey.trim()) {
    throw new TypeError("eventKey must be a nonempty string.");
  }
  return createHash("sha256").update(eventKey).digest("hex");
}

export function createConversationStore(firestore, { collection = "slack_conversations" } = {}) {
  documentSegment(collection, "collection");

  function threadRef(channel, threadTs) {
    return firestore.collection(collection)
      .doc(documentSegment(channel, "channel"))
      .collection("threads")
      .doc(documentSegment(threadTs, "threadTs"));
  }

  function eventRef(channel, threadTs, eventKey) {
    return threadRef(channel, threadTs).collection("claude_events").doc(eventId(eventKey));
  }

  return {
    async history(channel, threadTs) {
      const snapshot = await threadRef(channel, threadTs).collection("messages")
        .orderBy("createdAt", "asc").get();
      return snapshot.docs.map((document) => document.data())
        .filter((message) => ["user", "assistant"].includes(message?.role) && typeof message.content === "string")
        .map(({ role, content }) => ({ role, content }));
    },

    async saveTurn(channel, threadTs, { eventKey, prompt, answer }) {
      if (typeof prompt !== "string" || typeof answer !== "string") {
        throw new TypeError("Conversation prompt and answer must be strings, without attachment blocks.");
      }
      const messages = threadRef(channel, threadTs).collection("messages");
      const id = eventId(eventKey);
      const userRef = messages.doc(`claude_${id}_user`);
      const assistantRef = messages.doc(`claude_${id}_assistant`);
      await firestore.runTransaction(async (transaction) => {
        const [user, assistant] = await Promise.all([transaction.get(userRef), transaction.get(assistantRef)]);
        if (user.exists || assistant.exists) {
          if (!user.exists || !assistant.exists) throw new Error("A saved Claude conversation turn is incomplete.");
          return;
        }
        const createdAt = Date.now();
        const metadata = { provider: "claude", model: claudeModel };
        transaction.set(userRef, { role: "user", content: prompt, createdAt: new Date(createdAt), ...metadata });
        transaction.set(assistantRef, {
          role: "assistant",
          content: answer.startsWith(answerPrefix) ? answer : `${answerPrefix}${answer}`,
          createdAt: new Date(createdAt + 1),
          ...metadata,
        });
      });
    },

    async claimEvent(channel, threadTs, eventKey) {
      const reference = eventRef(channel, threadTs, eventKey);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (snapshot.exists) return false;
        const now = new Date();
        transaction.set(reference, { status: "processing", createdAt: now, updatedAt: now });
        return true;
      });
    },

    async finishEvent(channel, threadTs, eventKey, status) {
      if (typeof status !== "string" || !status.trim()) throw new TypeError("Event status must be a nonempty string.");
      await eventRef(channel, threadTs, eventKey).update({ status, updatedAt: new Date() });
    },
  };
}
