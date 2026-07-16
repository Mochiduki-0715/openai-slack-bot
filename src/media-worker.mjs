import { createReadStream, createWriteStream } from "node:fs";
import { readdir, readFile, rm, stat, mkdtemp, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Firestore } from "@google-cloud/firestore";
import { WebClient } from "@slack/web-api";
import { OAuth2Client } from "google-auth-library";
import OpenAI from "openai";
import {
  mediaJobRef,
  mediaMaxDurationSeconds,
  mediaTranscriptTtlDays,
} from "./media-jobs.mjs";

const execFile = promisify(execFileCallback);
const required = ["OPENAI_API_KEY", "SLACK_BOT_TOKEN", "MEDIA_WORKER_AUDIENCE"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const firestore = new Firestore();
const tokenVerifier = new OAuth2Client();
const defaultModel = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const conversationCollection =
  process.env.FIRESTORE_CONVERSATION_COLLECTION || "slack_conversations";
const transcriptionModel =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe-diarize";
const mediaMaxPdfBytes = Number(process.env.MEDIA_MAX_PDF_BYTES || 100 * 1024 * 1024);
const taskAudience = process.env.MEDIA_WORKER_AUDIENCE;
const taskInvoker = process.env.MEDIA_TASK_SERVICE_ACCOUNT;

class MediaProcessingError extends Error {}

function safeFilename(value, fallback) {
  const name = basename(value || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
  return name || fallback;
}

function secondsLabel(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function transcriptText(segments) {
  return segments
    .map((segment) => {
      const speaker = segment.speaker ? ` (${segment.speaker})` : "";
      return `[${secondsLabel(segment.start)}-${secondsLabel(segment.end)}]${speaker} ${segment.text}`;
    })
    .join("\n");
}

function splitTranscriptSegments(segments, maxCharacters = 3500) {
  const chunks = [];
  let current = [];
  let characters = 0;
  for (const segment of segments) {
    const line = `[${secondsLabel(segment.start)}-${secondsLabel(segment.end)}] ${segment.text}`;
    if (current.length > 0 && characters + line.length > maxCharacters) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(segment);
    characters += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function command(commandName, args, options = {}) {
  try {
    return await execFile(commandName, args, {
      timeout: 18 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const message = error.stderr || error.message;
    throw new MediaProcessingError(`${commandName} failed: ${String(message).slice(0, 500)}`);
  }
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  if (!response.ok || !response.body) {
    throw new MediaProcessingError(`Slack file download failed (${response.status}).`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function slackFileToPath(source, directory) {
  const result = await slack.files.info({ file: source.fileId });
  const file = result.file;
  if (!file) throw new MediaProcessingError("Slack file metadata was not found.");
  const url = file.url_private_download || file.url_private;
  if (!url) throw new MediaProcessingError("Slack file has no downloadable URL.");
  const destination = join(directory, safeFilename(file.name, `${source.fileId}.bin`));
  await downloadToFile(url, destination);
  return { path: destination, name: file.name || source.name, mimeType: file.mimetype || source.mimeType };
}

async function durationForFile(filePath) {
  const { stdout } = await command("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return Number.parseFloat(stdout.trim());
}

async function assertDuration(filePath) {
  const duration = await durationForFile(filePath);
  if (!Number.isFinite(duration)) {
    throw new MediaProcessingError("メディアの長さを取得できませんでした。");
  }
  if (duration > mediaMaxDurationSeconds) {
    throw new MediaProcessingError("動画・音声は15分以内にしてください。");
  }
  return duration;
}

async function extractFrames(videoPath, directory) {
  const output = join(directory, "frame-%02d.jpg");
  await command("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vf",
    "fps=1/60,scale=640:-2",
    "-frames:v",
    "15",
    output,
  ]);
  return (await readdir(directory))
    .filter((file) => /^frame-\d+\.jpg$/.test(file))
    .sort()
    .map((file) => join(directory, file));
}

async function extractAudio(videoPath, directory) {
  const output = join(directory, "audio.m4a");
  await command("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    output,
  ]);
  return output;
}

function normalizeSegments(result) {
  const source = result.segments || result.data?.segments || [];
  if (Array.isArray(source) && source.length > 0) {
    return source.map((segment) => ({
      start: Number(segment.start || segment.start_time || 0),
      end: Number(segment.end || segment.end_time || 0),
      speaker: segment.speaker || segment.speaker_id || undefined,
      text: String(segment.text || "").trim(),
    })).filter((segment) => segment.text);
  }
  const text = String(result.text || result.data?.text || "").trim();
  return text ? [{ start: 0, end: 0, text }] : [];
}

async function transcribe(audioPath) {
  const result = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: transcriptionModel,
    response_format: "diarized_json",
    chunking_strategy: "auto",
  });
  const segments = normalizeSegments(result);
  if (segments.length === 0) throw new MediaProcessingError("音声から文字起こしを生成できませんでした。");
  return segments;
}

function parseTimestamp(value) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseVtt(value) {
  const seen = new Set();
  const segments = [];
  for (const block of value.replace(/^WEBVTT[^\n]*\n/i, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timestampIndex = lines.findIndex((line) => line.includes("-->"));
    if (timestampIndex === -1) continue;
    const [start, end] = lines[timestampIndex].split("-->").map((part) => parseTimestamp(part));
    const text = lines.slice(timestampIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    const key = `${start}-${text}`;
    if (text && !seen.has(key)) {
      seen.add(key);
      segments.push({ start, end, text });
    }
  }
  return segments;
}

async function youtubeMediaToPaths(url, directory) {
  let metadata;
  try {
    const { stdout } = await command("yt-dlp", ["--no-playlist", "--skip-download", "--dump-single-json", url]);
    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new MediaProcessingError(`YouTube動画を取得できませんでした: ${error.message}`);
  }
  if (metadata.is_live || Number(metadata.duration || 0) > mediaMaxDurationSeconds) {
    throw new MediaProcessingError("YouTube動画は公開済みかつ15分以内のものだけ解析できます。");
  }

  const captionOutput = join(directory, "captions.%(ext)s");
  await command("yt-dlp", [
    "--no-playlist",
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "ja.*,en.*",
    "--sub-format",
    "vtt",
    "--output",
    captionOutput,
    url,
  ]).catch(() => undefined);
  const captions = (await readdir(directory)).filter((file) => file.endsWith(".vtt"));
  const captionSegments = captions.length > 0 ? parseVtt(await readFile(join(directory, captions[0]), "utf8")) : [];

  const videoOutput = join(directory, "youtube.%(ext)s");
  await command("yt-dlp", [
    "--no-playlist",
    "--max-filesize",
    "1G",
    "--format",
    "best[height<=360][ext=mp4]/best[height<=360]/best",
    "--output",
    videoOutput,
    url,
  ]);
  const videoName = (await readdir(directory)).find(
    (file) => file.startsWith("youtube.") && !file.endsWith(".vtt"),
  );
  if (!videoName) throw new MediaProcessingError("YouTube動画のダウンロードに失敗しました。");
  const videoPath = join(directory, videoName);
  if ((await stat(videoPath)).size > 1024 * 1024 * 1024) {
    throw new MediaProcessingError("YouTubeの解析用動画が1GBを超えたため処理を中止しました。");
  }
  return { videoPath, segments: captionSegments };
}

async function inputFileForPdf(filePath, name, mimeType) {
  const fileStat = await stat(filePath);
  if (fileStat.size > mediaMaxPdfBytes) {
    throw new MediaProcessingError("PDFは100MB以下にしてください。");
  }
  const file = await readFile(filePath);
  return {
    type: "input_file",
    filename: name,
    file_data: `data:${mimeType || "application/pdf"};base64,${file.toString("base64")}`,
  };
}

async function analyze(job, pdfInputs, segments, framePaths) {
  const content = [
    {
      type: "input_text",
      text: [
        job.prompt,
        segments.length > 0 ? `\n文字起こし:\n${transcriptText(segments)}` : "",
        "\n結論を先に述べ、重要な根拠・時刻・画面上の情報を簡潔にまとめてください。",
      ].join(""),
    },
    ...pdfInputs,
  ];
  for (const framePath of framePaths) {
    const frame = await readFile(framePath);
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${frame.toString("base64")}`,
      detail: "low",
    });
  }
  const response = await openai.responses.create({
    model: job.model || defaultModel,
    reasoning: { effort: process.env.OPENAI_REASONING_EFFORT || "medium" },
    instructions:
      "You are gpt in Slack. Reply in the user's language with Slack-compatible Markdown. For video and audio, cite timestamps from the supplied transcript when useful.",
    input: [{ role: "user", content }],
  });
  return response.output_text?.trim() || "解析結果を生成できませんでした。";
}

function conversationMessagesCollection(channel, threadTs) {
  return firestore
    .collection(conversationCollection)
    .doc(channel)
    .collection("threads")
    .doc(threadTs)
    .collection("messages");
}

async function saveConversationTurn(channel, threadTs, prompt, answer) {
  const messages = conversationMessagesCollection(channel, threadTs);
  const createdAt = Date.now();
  const batch = firestore.batch();
  batch.set(messages.doc(), { role: "user", content: prompt, createdAt: new Date(createdAt) });
  batch.set(messages.doc(), { role: "assistant", content: answer, createdAt: new Date(createdAt + 1) });
  await batch.commit();
}

async function saveTranscript(jobId, segments, expiresAt) {
  const chunks = splitTranscriptSegments(segments);
  for (let offset = 0; offset < chunks.length; offset += 400) {
    const batch = firestore.batch();
    for (const [index, chunk] of chunks.slice(offset, offset + 400).entries()) {
      const first = chunk[0];
      const last = chunk.at(-1);
      batch.set(mediaJobRef(firestore, jobId).collection("transcript_chunks").doc(String(offset + index).padStart(4, "0")), {
        text: transcriptText(chunk),
        start: first.start,
        end: last.end,
        expiresAt,
      });
    }
    await batch.commit();
  }
}

async function updateReceipt(job, text) {
  if (!job.receiptMessageTs) return;
  await slack.chat.update({ channel: job.channel, ts: job.receiptMessageTs, text });
}

async function processJob(jobId) {
  const ref = mediaJobRef(firestore, jobId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new MediaProcessingError("Unknown media job.");
  const job = snapshot.data();
  if (["completed", "processing"].includes(job.status)) return;

  await ref.update({ status: "processing", startedAt: new Date() });
  await updateReceipt(job, "_メディアを解析しています。文字起こしと代表場面を処理中です。_");
  const directory = await mkdtemp(join(tmpdir(), `gpt-media-${jobId}-`));
  try {
    const pdfInputs = [];
    const segments = [];
    const framePaths = [];

    for (const [index, source] of job.sources.entries()) {
      const sourceDirectory = join(directory, `source-${index}`);
      await mkdir(sourceDirectory);
      if (source.kind === "youtube") {
        const youtube = await youtubeMediaToPaths(source.url, sourceDirectory);
        framePaths.push(...(await extractFrames(youtube.videoPath, sourceDirectory)));
        if (youtube.segments.length > 0) {
          segments.push(...youtube.segments);
        } else {
          segments.push(...(await transcribe(await extractAudio(youtube.videoPath, sourceDirectory))));
        }
        continue;
      }

      const file = await slackFileToPath(source, sourceDirectory);
      if (source.kind === "pdf") {
        pdfInputs.push(await inputFileForPdf(file.path, file.name, file.mimeType));
        continue;
      }

      await assertDuration(file.path);
      if (source.kind === "video") {
        framePaths.push(...(await extractFrames(file.path, sourceDirectory)));
        segments.push(...(await transcribe(await extractAudio(file.path, sourceDirectory))));
      } else {
        segments.push(...(await transcribe(file.path)));
      }
    }

    const answer = await analyze(job, pdfInputs, segments, framePaths.slice(0, 15));
    const transcript = transcriptText(segments);
    if (segments.length > 0) {
      await saveTranscript(jobId, segments, job.expiresAt);
      await slack.filesUploadV2({
        channel_id: job.channel,
        thread_ts: job.threadTs,
        file: Buffer.from(transcript, "utf8"),
        filename: `gpt-transcript-${jobId}.md`,
        title: "文字起こし",
      });
    }
    await updateReceipt(job, `_${job.label || "Terra"}で解析完了_\n${answer}`);
    await saveConversationTurn(job.channel, job.threadTs, job.prompt, answer);
    await ref.update({ status: "completed", completedAt: new Date(), transcriptStored: segments.length > 0 });
  } catch (error) {
    const message = error instanceof MediaProcessingError
      ? error.message
      : "メディア解析中にエラーが発生しました。管理者はCloud Runログを確認してください。";
    await ref.update({ status: "failed", failedAt: new Date(), error: String(error).slice(0, 500) });
    await updateReceipt(job, `_${message}_`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyTaskRequest(request) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw new MediaProcessingError("Missing task authorization.");
  const ticket = await tokenVerifier.verifyIdToken({ idToken: token, audience: taskAudience });
  const payload = ticket.getPayload();
  if (taskInvoker && payload?.email !== taskInvoker) {
    throw new MediaProcessingError("Unexpected task service account.");
  }
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new MediaProcessingError("Task payload is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/tasks/media") {
    response.writeHead(404).end();
    return;
  }
  try {
    await verifyTaskRequest(request);
    const { jobId } = await requestBody(request);
    if (!jobId) throw new MediaProcessingError("Missing jobId.");
    await processJob(jobId);
    response.writeHead(204).end();
  } catch (error) {
    console.error(error);
    response.writeHead(error instanceof MediaProcessingError ? 400 : 500).end();
  }
});

server.listen(process.env.PORT || 8080, () => {
  console.log("OpenAI Slack media worker is listening for Cloud Tasks.");
});
