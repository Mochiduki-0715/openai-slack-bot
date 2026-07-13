import { App, LogLevel } from "@slack/bolt";
import OpenAI from "openai";

const required = ["OPENAI_API_KEY", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const defaultModel = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "medium";
const mentionModels = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
};
const allowedChannels = new Set(
  (process.env.ALLOWED_CHANNEL_IDS || "")
    .split(",")
    .map((channelId) => channelId.trim())
    .filter(Boolean),
);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  logLevel: LogLevel.INFO,
});

const systemPrompt = [
  "You are gpt, a helpful assistant in Slack.",
  "Reply in the user's language and use plain Slack-compatible Markdown.",
  "Give detailed, well-structured answers: lead with the conclusion, then explain reasoning, practical steps, and important caveats when useful.",
  "Use web search when the user asks for current information, verification, links, or facts that may have changed. Do not search when it is unnecessary.",
  "When web search is used, include the most useful source links in the answer.",
  "Do not claim you performed actions you did not perform.",
  "Accuracy, safety, and the user's instructions take priority.",
].join(" ");

function withoutMentions(text) {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

function selectModel(text) {
  const match = text.match(/^(sol|terra)\b\s*/i);

  if (!match) {
    return { model: defaultModel, label: "Terra", prompt: text };
  }

  const key = match[1].toLowerCase();
  return {
    model: mentionModels[key],
    label: key === "sol" ? "Sol" : "Terra",
    prompt: text.slice(match[0].length).trim(),
  };
}

app.event("app_mention", async ({ event, client, logger }) => {
  if (allowedChannels.size > 0 && !allowedChannels.has(event.channel)) {
    logger.warn(`Ignored mention from unauthorized channel ${event.channel}`);
    return;
  }

  const selection = selectModel(withoutMentions(event.text));
  const { model, label, prompt } = selection;
  const threadTs = event.thread_ts ?? event.ts;

  if (!prompt) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "質問を続けて書いてください。",
    });
    return;
  }

  try {
    logger.info(`Generating ${label} response for Slack event ${event.ts}`);
    const response = await openai.responses.create({
      model,
      reasoning: { effort: reasoningEffort },
      tools: [{ type: "web_search" }],
      instructions: systemPrompt,
      input: prompt,
    });
    const answer = response.output_text?.trim() || "回答を生成できませんでした。";

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `_${label}で回答_\n${answer}`,
    });
    logger.info(`Posted ${label} response for Slack event ${event.ts}`);
  } catch (error) {
    logger.error(error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "エラーが発生しました。管理者はサーバーのログを確認してください。",
    });
  }
});

await app.start(process.env.PORT || 8080);
console.log(`OpenAI Slack bot is listening for Slack Events with ${defaultModel}.`);
