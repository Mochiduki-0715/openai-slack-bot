import { execFileSync, spawnSync } from "node:child_process";

const project = process.env.GOOGLE_CLOUD_PROJECT || "mochiduki-gpt-slack-260713";
const region = process.env.CLOUD_RUN_REGION || "asia-northeast1";
const service = process.env.CLOUD_RUN_SERVICE || "gpt-slack-bot";
const worker = process.env.MEDIA_WORKER_SERVICE || `${service}-media-worker`;
const serviceAccount =
  process.env.CLOUD_RUN_SERVICE_ACCOUNT ||
  `gpt-slack-bot@${project}.iam.gserviceaccount.com`;
const taskServiceAccount =
  process.env.MEDIA_TASK_SERVICE_ACCOUNT || `${service}-media-task@${project}.iam.gserviceaccount.com`;
const queue = process.env.MEDIA_TASK_QUEUE || "gpt-slack-media";
const usageSchedulerServiceAccount =
  process.env.MONTHLY_USAGE_SCHEDULER_SERVICE_ACCOUNT ||
  `gpt-monthly-usage-scheduler@${project}.iam.gserviceaccount.com`;
const usageSecret = process.env.OPENAI_USAGE_SECRET || "openai-usage-admin-key";
const openaiCostProject = process.env.OPENAI_COST_PROJECT_ID || "proj_11LZLIyW6LWVTNDmQNBE1Dsd";

function gcloud(args) {
  return execFileSync("gcloud", args, { encoding: "utf8" }).trim();
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function deploymentChannel() {
  if (process.env.DEPLOYMENT_NOTIFICATION_CHANNEL_ID) {
    return process.env.DEPLOYMENT_NOTIFICATION_CHANNEL_ID;
  }

  const serviceConfig = JSON.parse(
    gcloud([
      "run",
      "services",
      "describe",
      service,
      "--region",
      region,
      "--project",
      project,
      "--format=json",
    ]),
  );
  const environments = serviceConfig.spec?.template?.spec?.containers?.flatMap(
    (container) => container.env || [],
  );
  const channel = environments?.find(
    (environment) => environment.name === "DEPLOYMENT_NOTIFICATION_CHANNEL_ID",
  )?.value;

  if (!channel) {
    throw new Error(
      "Set DEPLOYMENT_NOTIFICATION_CHANNEL_ID on the Cloud Run service or in this shell.",
    );
  }
  return channel;
}

async function notify(channel, text) {
  const token = gcloud([
    "secrets",
    "versions",
    "access",
    "latest",
    "--secret=slack-bot-token",
    "--project",
    project,
  ]);
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Slack notification failed: ${result.error || response.status}`);
  }
}

async function tryNotify(channel, text) {
  try {
    await notify(channel, text);
  } catch (error) {
    console.error(`Unable to send Slack deployment notification: ${error.message}`);
  }
}

function serviceStatus(target = service) {
  return JSON.parse(
    gcloud([
      "run",
      "services",
      "describe",
      target,
      "--region",
      region,
      "--project",
      project,
      "--format=json",
    ]),
  );
}

function serviceRevision(target = service) {
  try {
    return serviceStatus(target).status?.latestReadyRevisionName;
  } catch {
    return undefined;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForNewRevision(previousRevision, target = service) {
  const timeout = Number(process.env.DEPLOY_WAIT_TIMEOUT_MS || 600_000);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    let status;
    try {
      status = serviceStatus(target).status || {};
    } catch {
      await wait(5_000);
      continue;
    }
    const revision = status.latestReadyRevisionName;
    const traffic = status.traffic || [];
    const isServing = traffic.some(
      (route) => route.revisionName === revision && route.percent === 100,
    );

    if (revision && revision !== previousRevision && isServing) {
      return revision;
    }
    await wait(5_000);
  }

  throw new Error(`Timed out waiting for ${target} to receive 100% traffic.`);
}

function deployReceiver(workerUrl, receiverUrl, channel) {
  return spawnSync(
    "gcloud",
    [
      "run",
      "deploy",
      service,
      "--source",
      ".",
      "--region",
      region,
      "--project",
      project,
      "--service-account",
      serviceAccount,
      "--clear-base-image",
      "--update-env-vars",
      `MEDIA_WORKER_URL=${workerUrl},MEDIA_TASK_SERVICE_ACCOUNT=${taskServiceAccount},MEDIA_TASK_QUEUE=${queue},MONTHLY_USAGE_REPORT_CHANNEL_ID=${channel},MONTHLY_USAGE_SCHEDULER_SERVICE_ACCOUNT=${usageSchedulerServiceAccount},MONTHLY_USAGE_SCHEDULER_AUDIENCE=${receiverUrl},OPENAI_COST_PROJECT_ID=${openaiCostProject}`,
      "--update-secrets",
      `OPENAI_ADMIN_KEY=${usageSecret}:latest`,
      "--quiet",
    ],
    { stdio: "inherit" },
  );
}

function deployWorker() {
  const model = process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const reasoning = process.env.OPENAI_REASONING_EFFORT || "medium";
  const conversationCollection =
    process.env.FIRESTORE_CONVERSATION_COLLECTION || "slack_conversations";
  return spawnSync(
    "gcloud",
    [
      "run",
      "deploy",
      worker,
      "--source",
      ".",
      "--region",
      region,
      "--project",
      project,
      "--service-account",
      serviceAccount,
      "--clear-base-image",
      "--no-allow-unauthenticated",
      "--command",
      "node",
      "--args",
      "src/media-worker.mjs",
      "--cpu",
      "2",
      "--memory",
      "4Gi",
      "--concurrency",
      "1",
      "--timeout",
      "1200",
      "--min",
      "0",
      "--set-secrets",
      "OPENAI_API_KEY=openai-api-key:latest,SLACK_BOT_TOKEN=slack-bot-token:latest",
      "--set-env-vars",
      `OPENAI_MODEL=${model},OPENAI_REASONING_EFFORT=${reasoning},FIRESTORE_CONVERSATION_COLLECTION=${conversationCollection},MEDIA_TASK_SERVICE_ACCOUNT=${taskServiceAccount},MEDIA_TASK_QUEUE=${queue},MEDIA_WORKER_AUDIENCE=https://placeholder.invalid`,
      "--quiet",
    ],
    { stdio: "inherit" },
  );
}

function runSetup(args = []) {
  const result = spawnSync("node", ["scripts/setup-media-processing.mjs", ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Media processing setup failed.");
}

function runMonthlyUsageSetup() {
  const result = spawnSync("node", ["scripts/setup-monthly-usage-report.mjs"], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Monthly usage report setup failed.");
}

function workerUrl() {
  return gcloud([
    "run",
    "services",
    "describe",
    worker,
    "--region",
    region,
    "--project",
    project,
    "--format=value(status.url)",
  ]);
}

function updateWorkerAudience(url) {
  const result = spawnSync(
    "gcloud",
    [
      "run",
      "services",
      "update",
      worker,
      "--region",
      region,
      "--project",
      project,
      "--update-env-vars",
      `MEDIA_WORKER_AUDIENCE=${url}`,
      "--quiet",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not update the media worker audience.");
}

const summary = optionValue("--summary") || process.env.DEPLOY_SUMMARY || "変更を反映";
const notificationSuffix = `\n追加・変更: ${summary}`;
const channel = deploymentChannel();
const previousRevision = serviceRevision();

await tryNotify(channel, `🚀 gpt のデプロイを開始します${notificationSuffix}`);

try {
  runSetup();
  const previousWorkerRevision = serviceRevision(worker);
  const workerResult = deployWorker();
  if (workerResult.error || workerResult.status !== 0) {
    throw workerResult.error || new Error(`Media worker deployment exited with status ${workerResult.status}.`);
  }
  await waitForNewRevision(previousWorkerRevision, worker);
  const url = workerUrl();
  updateWorkerAudience(url);
  runSetup(["--bind-worker"]);

  const receiverUrl = serviceStatus().status?.url;
  if (!receiverUrl) throw new Error("Unable to determine the receiver service URL.");
  runMonthlyUsageSetup();
  const result = deployReceiver(url, receiverUrl, channel);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`gcloud run deploy exited with status ${result.status}.`);
  }

  const revision = await waitForNewRevision(previousRevision);
  await tryNotify(
    channel,
    `✅ gpt のデプロイが完了しました\nリビジョン: ${revision}${notificationSuffix}`,
  );
} catch (error) {
  await tryNotify(
    channel,
    `❌ gpt のデプロイに失敗しました${notificationSuffix}\n${error.message.slice(0, 500)}`,
  );
  throw error;
}
