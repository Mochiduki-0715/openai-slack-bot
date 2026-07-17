import { App, HTTPReceiver, LogLevel } from "@slack/bolt";
import { Firestore } from "@google-cloud/firestore";
import { OAuth2Client } from "google-auth-library";
import OpenAI from "openai";
import { fetchOpenAICosts, monthlyUsageMessage, previousMonthRange } from "./monthly-usage.mjs";
import {
  enqueueMediaTask,
  eventFiles,
  extractYouTubeUrls,
  mediaJobExpiresAt,
  mediaJobRef,
  mediaKindForMimeType,
  mediaMaxSlackFileBytes,
  quotaResetMessage,
  reserveMediaJob,
  safeJobId,
} from "./media-jobs.mjs";

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
const conversationCollection =
  process.env.FIRESTORE_CONVERSATION_COLLECTION || "slack_conversations";
const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const usageReportChannel =
  process.env.MONTHLY_USAGE_REPORT_CHANNEL_ID || process.env.DEPLOYMENT_NOTIFICATION_CHANNEL_ID;
const usageReportCollection = process.env.FIRESTORE_USAGE_REPORT_COLLECTION || "openai_usage_reports";
const schedulerServiceAccount = process.env.MONTHLY_USAGE_SCHEDULER_SERVICE_ACCOUNT;
const schedulerAudience = process.env.MONTHLY_USAGE_SCHEDULER_AUDIENCE;
const schedulerTokenVerifier = new OAuth2Client();
const firestore = new Firestore();

const receiver = new HTTPReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  customRoutes: [
    {
      path: "/internal/monthly-usage",
      method: "POST",
      handler: (request, response) => {
        void handleMonthlyUsageRequest(request, response);
      },
    },
  ],
});

const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver, logLevel: LogLevel.INFO });

const systemPrompt = [
  "You are gpt, a helpful assistant in Slack.",
  "Reply in the user's language and use plain Slack-compatible Markdown.",
  "Give detailed, well-structured answers: lead with the conclusion, then explain reasoning, practical steps, and important caveats when useful.",
  "Use web search when the user asks for current information, verification, links, or facts that may have changed. Do not search when it is unnecessary.",
  "When web search is used, include the most useful source links in the answer.",
  "When the user asks to create or edit an image, use the image generation tool and briefly describe the result.",
  "When images are attached to a message, analyze the images together with the user's request.",
  "Do not claim you performed actions you did not perform.",
  "Accuracy, safety, and the user's instructions take priority.",
].join(" ");

function withoutMentions(text) {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

function selectModel(text) {
  let prompt = text;
  let model = defaultModel;
  let label = "Terra";
  const modelMatch = prompt.match(/^(sol|terra)\b\s*/i);

  if (modelMatch) {
    const key = modelMatch[1].toLowerCase();
    model = mentionModels[key];
    label = key === "sol" ? "Sol" : "Terra";
    prompt = prompt.slice(modelMatch[0].length).trim();
  }

  const imageCommandMatch = prompt.match(/^image\b\s*/i);
  return {
    model,
    label,
    prompt: imageCommandMatch
      ? prompt.slice(imageCommandMatch[0].length).trim()
      : prompt,
    forceImageGeneration: Boolean(imageCommandMatch),
  };
}

async function inputImageForSlackFile(client, file) {
  if (!file?.id) {
    return null;
  }

  const result = await client.files.info({ file: file.id });
  const slackFile = result.file;
  if (!slackFile?.mimetype?.startsWith("image/")) {
    return null;
  }

  const downloadUrl = slackFile.url_private_download || slackFile.url_private;
  if (!downloadUrl) {
    return null;
  }

  const download = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  if (!download.ok) {
    throw new Error(`Unable to download Slack image ${slackFile.id}: ${download.status}`);
  }

  const mimeType = download.headers.get("content-type") || slackFile.mimetype;
  const image = Buffer.from(await download.arrayBuffer()).toString("base64");
  return {
    type: "input_image",
    image_url: `data:${mimeType};base64,${image}`,
  };
}

async function inputImagesForEvent(client, event) {
  const images = await Promise.all(
    eventFiles(event).map((file) => inputImageForSlackFile(client, file)),
  );
  return images.filter(Boolean);
}

function userInput(prompt, images) {
  const text = prompt || "添付画像を解析してください。";
  if (images.length === 0) {
    return { role: "user", content: text };
  }

  return {
    role: "user",
    content: [{ type: "input_text", text }, ...images],
  };
}

function generatedImages(response) {
  return response.output.filter(
    (item) => item.type === "image_generation_call" && item.result,
  );
}

async function acknowledgeMention(client, event, logger) {
  try {
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: "eyes",
    });
  } catch (error) {
    if (error?.data?.error !== "already_reacted") {
      logger.warn(`Unable to add acknowledgement reaction: ${error}`);
    }
  }
}

async function postGeneratedImages(client, channel, threadTs, label, answer, images) {
  await Promise.all(
    images.map((image, index) =>
      client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: Buffer.from(image.result, "base64"),
        filename: `gpt-image-${index + 1}.png`,
        title: `gpt generated image ${index + 1}`,
        initial_comment:
          index === 0
            ? `_${label}で画像を生成_\n${answer || "画像を生成しました。"}`
            : undefined,
      }),
    ),
  );
}

function conversationMessagesCollection(channel, threadTs) {
  return firestore
    .collection(conversationCollection)
    .doc(channel)
    .collection("threads")
    .doc(threadTs)
    .collection("messages");
}

function conversationMessages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (message) =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message.content === "string",
    )
    .map(({ role, content }) => ({ role, content }));
}

async function getConversationHistory(channel, threadTs) {
  const snapshot = await conversationMessagesCollection(channel, threadTs)
    .orderBy("createdAt", "asc")
    .get();

  return conversationMessages(snapshot.docs.map((document) => document.data()));
}

async function saveConversationTurn(channel, threadTs, prompt, answer) {
  const messages = conversationMessagesCollection(channel, threadTs);
  const createdAt = Date.now();
  const batch = firestore.batch();

  batch.set(messages.doc(), {
    role: "user",
    content: prompt,
    createdAt: new Date(createdAt),
  });
  batch.set(messages.doc(), {
    role: "assistant",
    content: answer,
    createdAt: new Date(createdAt + 1),
  });

  await batch.commit();
}

class MediaRequestError extends Error {}

async function mediaSourcesForEvent(client, event, prompt) {
  const sources = [];
  for (const file of eventFiles(event)) {
    if (!file?.id) continue;
    const result = await client.files.info({ file: file.id });
    const slackFile = result.file;
    const kind = mediaKindForMimeType(slackFile?.mimetype || "");
    if (!kind) continue;

    if (
      ["audio", "video"].includes(kind) &&
      Number(slackFile.size || 0) > mediaMaxSlackFileBytes
    ) {
      throw new MediaRequestError(
        "動画・音声の添付は1GB以下にしてください。YouTube URLは15分以内ならサイズ制限なしで解析できます。",
      );
    }
    sources.push({
      kind,
      fileId: slackFile.id,
      name: slackFile.name || file.name || `slack-${file.id}`,
      mimeType: slackFile.mimetype,
      size: Number(slackFile.size || 0),
    });
  }

  for (const url of extractYouTubeUrls(prompt)) {
    sources.push({ kind: "youtube", url });
  }
  return sources;
}

async function queueMediaJob(client, event, selection, body, logger) {
  const sources = await mediaSourcesForEvent(client, event, selection.prompt);
  if (sources.length === 0) return false;

  const threadTs = event.thread_ts ?? event.ts;
  const jobId = safeJobId(body?.event_id || event.client_msg_id || `${event.channel}-${event.ts}`);
  const expiresAt = mediaJobExpiresAt();
  const job = {
    id: jobId,
    channel: event.channel,
    threadTs,
    eventTs: event.ts,
    prompt: selection.prompt || "添付メディアを解析してください。",
    model: selection.model,
    label: selection.label,
    sources,
    expiresAt,
  };
  const reservation = await reserveMediaJob(firestore, job);
  if (reservation.duplicate) {
    logger.info(`Ignored duplicate media job ${jobId}`);
    return true;
  }
  if (!reservation.accepted) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: quotaResetMessage(reservation.limit),
    });
    return true;
  }

  const receipt = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: "_メディア解析を受け付けました。ダウンロードと解析が完了したら、このスレッドへ投稿します。_",
  });
  await mediaJobRef(firestore, jobId).update({ receiptMessageTs: receipt.ts });

  try {
    await enqueueMediaTask(jobId);
  } catch (error) {
    logger.error(`Unable to enqueue media job ${jobId}: ${error}`);
    await mediaJobRef(firestore, jobId).update({
      status: "failed",
      error: String(error).slice(0, 500),
    });
    await client.chat.update({
      channel: event.channel,
      ts: receipt.ts,
      text: "_メディア解析を開始できませんでした。管理者はCloud Tasksの設定を確認してください。_",
    });
  }
  return true;
}

app.event("app_mention", async ({ event, client, logger, body }) => {
  if (allowedChannels.size > 0 && !allowedChannels.has(event.channel)) {
    logger.warn(`Ignored mention from unauthorized channel ${event.channel}`);
    return;
  }

  await acknowledgeMention(client, event, logger);

  const selection = selectModel(withoutMentions(event.text));
  const { model, label, prompt, forceImageGeneration } = selection;
  const threadTs = event.thread_ts ?? event.ts;

  if (!prompt && eventFiles(event).length === 0) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: forceImageGeneration
        ? "`image` の後に、生成したい画像の内容を書いてください。"
        : "質問を続けて書いてください。",
    });
    return;
  }

  try {
    if (await queueMediaJob(client, event, selection, body, logger)) {
      return;
    }

    logger.info(`Generating ${label} response for Slack event ${event.ts}`);
    const images = await inputImagesForEvent(client, event);
    if (!prompt && images.length === 0) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "質問を書くか、解析したい画像を添付してください。",
      });
      return;
    }

    const userPrompt = prompt || "添付画像を解析してください。";
    const storedPrompt = images.length > 0 ? `${userPrompt}\n[添付画像: ${images.length}件]` : userPrompt;
    const history = await getConversationHistory(event.channel, threadTs);
    const response = await openai.responses.create({
      model,
      reasoning: { effort: reasoningEffort },
      tools: [
        { type: "web_search" },
        { type: "image_generation", action: "auto", model: imageModel },
      ],
      tool_choice: forceImageGeneration ? { type: "image_generation" } : "auto",
      instructions: forceImageGeneration
        ? `${systemPrompt} The user explicitly invoked the image command, so generate an image.`
        : systemPrompt,
      input: [...history, userInput(userPrompt, images)],
    });
    const generatedImageResults = generatedImages(response);
    const answer = response.output_text?.trim();

    if (generatedImageResults.length > 0) {
      await postGeneratedImages(
        client,
        event.channel,
        threadTs,
        label,
        answer,
        generatedImageResults,
      );
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `_${label}で回答_\n${answer || "回答を生成できませんでした。"}`,
      });
    }
    await saveConversationTurn(
      event.channel,
      threadTs,
      storedPrompt,
      answer || "[画像を生成しました。]",
    );
    logger.info(`Posted ${label} response for Slack event ${event.ts}`);
  } catch (error) {
    logger.error(error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text:
        error instanceof MediaRequestError
          ? error.message
          : "エラーが発生しました。管理者はサーバーのログを確認してください。",
    });
  }
});

async function verifyMonthlyUsageRequest(request) {
  if (!schedulerServiceAccount || !schedulerAudience) {
    throw new Error("Monthly usage scheduler authentication is not configured.");
  }
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return false;

  const ticket = await schedulerTokenVerifier.verifyIdToken({
    idToken: token,
    audience: schedulerAudience,
  });
  const payload = ticket.getPayload();
  return payload?.email_verified === true && payload.email === schedulerServiceAccount;
}

async function postMonthlyUsageReport(client) {
  if (!process.env.OPENAI_ADMIN_KEY) {
    throw new Error("OPENAI_ADMIN_KEY is not configured.");
  }
  if (!usageReportChannel) {
    throw new Error("MONTHLY_USAGE_REPORT_CHANNEL_ID is not configured.");
  }

  const period = previousMonthRange();
  const reportRef = firestore.collection(usageReportCollection).doc(period.yearMonth);
  try {
    await reportRef.create({ status: "processing", period: period.yearMonth, createdAt: new Date() });
  } catch (error) {
    if (error?.code === 6) return { alreadyReported: true, period };
    throw error;
  }

  try {
    const usage = await fetchOpenAICosts({
      apiKey: process.env.OPENAI_ADMIN_KEY,
      startTime: period.startTime,
      endTime: period.endTime,
      projectId: process.env.OPENAI_COST_PROJECT_ID,
    });
    const response = await client.chat.postMessage({
      channel: usageReportChannel,
      text: monthlyUsageMessage(usage),
    });
    await reportRef.update({
      status: "posted",
      amount: usage.amount,
      currency: usage.currency,
      messageTs: response.ts,
      postedAt: new Date(),
    });
    return { alreadyReported: false, period, usage };
  } catch (error) {
    await reportRef.delete();
    throw error;
  }
}

async function handleMonthlyUsageRequest(request, response) {
  try {
    if (!(await verifyMonthlyUsageRequest(request))) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const result = await postMonthlyUsageReport(app.client);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        alreadyReported: result.alreadyReported,
        period: result.period.yearMonth,
      }),
    );
  } catch (error) {
    console.error("Unable to post monthly OpenAI usage report", error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Unable to post monthly usage report" }));
  }
}

await app.start(process.env.PORT || 8080);
console.log(`OpenAI Slack bot is listening for Slack Events with ${defaultModel}.`);
