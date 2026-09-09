import { App, HTTPReceiver, LogLevel } from "@slack/bolt";
import { Firestore } from "@google-cloud/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { createConversationStore } from "./conversations.mjs";
import { createMentionHandler } from "./handler.mjs";
import { claudeModel } from "./model.mjs";

const required = ["ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
const conversations = createConversationStore(new Firestore(), {
  collection: process.env.FIRESTORE_CONVERSATION_COLLECTION || "slack_conversations",
});
const allowedChannels = new Set((process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",").map((channel) => channel.trim()).filter(Boolean));
const receiver = new HTTPReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO,
  clientOptions: { timeout: 30_000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
});
app.event("app_mention", createMentionHandler({ anthropic, conversations, allowedChannels }));

await app.start(Number(process.env.PORT || 8080));
console.log(`Claude Slack bot is running with ${claudeModel} (adaptive/max).`);
