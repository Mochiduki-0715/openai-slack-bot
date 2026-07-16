import { CloudTasksClient } from "@google-cloud/tasks";
import { Firestore } from "@google-cloud/firestore";

export const mediaJobsCollection = process.env.MEDIA_JOBS_COLLECTION || "media_jobs";
export const mediaUsageCollection = process.env.MEDIA_USAGE_COLLECTION || "media_usage";
export const mediaMaxDurationSeconds = Number(
  process.env.MEDIA_MAX_DURATION_SECONDS || 900,
);
export const mediaMaxSlackFileBytes = Number(
  process.env.MEDIA_MAX_SLACK_FILE_BYTES || 1024 * 1024 * 1024,
);
export const mediaDailyQuota = Number(process.env.MEDIA_DAILY_QUOTA || 10);
export const mediaMonthlyQuota = Number(process.env.MEDIA_MONTHLY_QUOTA || 90);
export const mediaTranscriptTtlDays = Number(
  process.env.MEDIA_TRANSCRIPT_TTL_DAYS || 30,
);

const project = process.env.GOOGLE_CLOUD_PROJECT || "mochiduki-gpt-slack-260713";
const region = process.env.CLOUD_RUN_REGION || "asia-northeast1";
const queue = process.env.MEDIA_TASK_QUEUE || "gpt-slack-media";

export function eventFiles(event) {
  return Array.isArray(event.files) ? event.files : [];
}

export function mediaKindForMimeType(mimeType = "") {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

export function isYouTubeHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
}

export function extractYouTubeUrls(text = "") {
  const urls = new Set();
  const normalized = text.replace(/<(https?:[^>|]+)(?:\|[^>]+)?>/g, "$1");
  for (const candidate of normalized.match(/https?:\/\/[^\s<>]+/g) || []) {
    try {
      const url = new URL(candidate.replace(/[),.]+$/, ""));
      if (isYouTubeHost(url.hostname)) urls.add(url.toString());
    } catch {
      // Ignore malformed links; the normal text response can still handle them.
    }
  }
  return [...urls];
}

export function japanUsageKeys(now = new Date()) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type) => values.find((value) => value.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return { day: `${year}-${month}-${day}`, month: `${year}-${month}` };
}

export function consumesMediaQuota(sources) {
  return sources.some((source) =>
    ["audio", "video", "youtube"].includes(source.kind),
  );
}

export function mediaJobRef(firestore, jobId) {
  return firestore.collection(mediaJobsCollection).doc(jobId);
}

export async function reserveMediaJob(firestore, job) {
  const jobRef = mediaJobRef(firestore, job.id);
  const quotaRequired = consumesMediaQuota(job.sources);
  const usageKeys = japanUsageKeys();
  const dailyRef = firestore.collection(mediaUsageCollection).doc(`day-${usageKeys.day}`);
  const monthlyRef = firestore.collection(mediaUsageCollection).doc(`month-${usageKeys.month}`);

  return firestore.runTransaction(async (transaction) => {
    const existing = await transaction.get(jobRef);
    if (existing.exists) return { accepted: false, duplicate: true };

    if (quotaRequired) {
      const [daily, monthly] = await Promise.all([
        transaction.get(dailyRef),
        transaction.get(monthlyRef),
      ]);
      const dailyCount = daily.exists ? Number(daily.data().count || 0) : 0;
      const monthlyCount = monthly.exists ? Number(monthly.data().count || 0) : 0;

      if (dailyCount >= mediaDailyQuota) {
        return { accepted: false, limit: "daily", usageKeys };
      }
      if (monthlyCount >= mediaMonthlyQuota) {
        return { accepted: false, limit: "monthly", usageKeys };
      }

      transaction.set(
        dailyRef,
        { count: dailyCount + 1, updatedAt: new Date(), expiresAt: job.expiresAt },
        { merge: true },
      );
      transaction.set(
        monthlyRef,
        { count: monthlyCount + 1, updatedAt: new Date(), expiresAt: job.expiresAt },
        { merge: true },
      );
    }

    transaction.create(jobRef, {
      ...job,
      quotaRequired,
      status: "queued",
      createdAt: new Date(),
    });
    return { accepted: true, usageKeys };
  });
}

export async function enqueueMediaTask(jobId) {
  const workerUrl = process.env.MEDIA_WORKER_URL;
  const taskServiceAccount = process.env.MEDIA_TASK_SERVICE_ACCOUNT;
  if (!workerUrl || !taskServiceAccount) {
    throw new Error("MEDIA_WORKER_URL and MEDIA_TASK_SERVICE_ACCOUNT must be configured.");
  }

  const client = new CloudTasksClient();
  const parent = client.queuePath(project, region, queue);
  const target = new URL("/tasks/media", workerUrl).toString();
  await client.createTask({
    parent,
    task: {
      name: client.taskPath(project, region, queue, `media-${jobId}`),
      httpRequest: {
        httpMethod: "POST",
        url: target,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ jobId })),
        oidcToken: {
          serviceAccountEmail: taskServiceAccount,
          audience: workerUrl,
        },
      },
    },
  });
}

export function mediaJobExpiresAt() {
  return new Date(Date.now() + mediaTranscriptTtlDays * 24 * 60 * 60 * 1000);
}

export function safeJobId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 150);
}

export function quotaResetMessage(limit) {
  return limit === "daily"
    ? "動画・音声解析は本日の上限（10本）に達しました。日本時間の午前0時以降に再試行してください。"
    : "動画・音声解析は今月の上限（90本）に達しました。来月に再試行してください。";
}

export function createFirestore() {
  return new Firestore();
}
