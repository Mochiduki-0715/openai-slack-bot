import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = fileURLToPath(new URL("../", import.meta.url));
const secretBindings = {
  ANTHROPIC_API_KEY: "anthropic-api-key",
  SLACK_BOT_TOKEN: "claude-slack-bot-token",
  SLACK_SIGNING_SECRET: "claude-slack-signing-secret",
};

export function deploymentConfig(environment = process.env) {
  const project = environment.GOOGLE_CLOUD_PROJECT || "mochiduki-gpt-slack-260713";
  const region = environment.CLOUD_RUN_REGION || "asia-northeast1";
  return {
    project,
    region,
    service: "claude-slack-bot",
    serviceAccount: `claude-slack-bot@${project}.iam.gserviceaccount.com`,
    conversationCollection: "slack_conversations",
  };
}

export function isMissingResourceError(stderr) {
  return /NOT_FOUND|does not exist|was not found|Cannot find service \[[^\]]+\]/i.test(stderr || "");
}

function gcloud(args, { allowMissing = false, inherit = false } = {}) {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing && isMissingResourceError(result.stderr)) {
      return undefined;
    }
    throw new Error(`gcloud ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || `exit ${result.status}`).trim()}`);
  }
  return (result.stdout || "").trim();
}

function serviceStatus(config, service = config.service) {
  const result = gcloud([
    "run", "services", "describe", service,
    "--project", config.project, "--region", config.region, "--format=json",
  ], { allowMissing: true });
  return result ? JSON.parse(result) : undefined;
}

function serviceEnvironment(status, name) {
  return status?.spec?.template?.spec?.containers
    ?.flatMap((container) => container.env || [])
    .find((entry) => entry.name === name)?.value;
}

export function resolveSharedConversationCollection(gptStatus) {
  if (!gptStatus) {
    throw new Error("The existing gpt-slack-bot service is required to determine its shared conversation collection.");
  }
  return serviceEnvironment(gptStatus, "FIRESTORE_CONVERSATION_COLLECTION") || "slack_conversations";
}

export function resolveChannels(environment, ownStatus, gptStatus) {
  const channel = environment.DEPLOYMENT_NOTIFICATION_CHANNEL_ID
    || serviceEnvironment(ownStatus, "DEPLOYMENT_NOTIFICATION_CHANNEL_ID")
    || serviceEnvironment(gptStatus, "DEPLOYMENT_NOTIFICATION_CHANNEL_ID");
  if (!channel || !/^[CGD][A-Z0-9]+$/.test(channel)) {
    throw new Error("Set DEPLOYMENT_NOTIFICATION_CHANNEL_ID to the Slack channel ID and invite @claude to that channel before deploying.");
  }
  const allowedChannels = environment.ALLOWED_CHANNEL_IDS
    ?? serviceEnvironment(ownStatus, "ALLOWED_CHANNEL_IDS")
    ?? serviceEnvironment(gptStatus, "ALLOWED_CHANNEL_IDS")
    ?? channel;
  const channels = allowedChannels.split(",").map((value) => value.trim()).filter(Boolean);
  if (channels.some((value) => !/^[CGD][A-Z0-9]+$/.test(value))) {
    throw new Error("ALLOWED_CHANNEL_IDS must contain comma-separated Slack channel IDs.");
  }
  return { channel, allowedChannels: channels.join(",") };
}

export function deploymentArgs(config, { channel, allowedChannels }) {
  return [
    "run", "deploy", config.service,
    "--source", sourceDirectory,
    "--project", config.project, "--region", config.region,
    "--service-account", config.serviceAccount,
    "--clear-base-image", "--allow-unauthenticated", "--no-cpu-throttling",
    "--cpu", "1", "--memory", "1Gi", "--concurrency", "10", "--timeout", "900",
    "--min", "0", "--max", "3",
    "--set-secrets", Object.entries(secretBindings).map(([name, secret]) => `${name}=${secret}:latest`).join(","),
    "--set-env-vars", [
      "^|^NODE_ENV=production",
      `GOOGLE_CLOUD_PROJECT=${config.project}`,
      `FIRESTORE_CONVERSATION_COLLECTION=${config.conversationCollection}`,
      `DEPLOYMENT_NOTIFICATION_CHANNEL_ID=${channel}`,
      `ALLOWED_CHANNEL_IDS=${allowedChannels}`,
    ].join("|"),
    "--quiet",
  ];
}

async function notify(token, channel, text) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Claude Slack notification failed: ${result.error || response.status}`);
  }
}

function ensureRuntimeAccess(config) {
  const account = gcloud([
    "iam", "service-accounts", "describe", config.serviceAccount,
    "--project", config.project, "--format=value(email)",
  ], { allowMissing: true });
  if (!account) {
    gcloud([
      "iam", "service-accounts", "create", "claude-slack-bot",
      "--project", config.project, "--display-name=Claude Slack bot", "--quiet",
    ], { inherit: true });
  }
  gcloud([
    "projects", "add-iam-policy-binding", config.project,
    "--member", `serviceAccount:${config.serviceAccount}`,
    "--role", "roles/datastore.user", "--condition=None", "--quiet",
  ]);
  for (const secret of Object.values(secretBindings)) {
    gcloud([
      "secrets", "add-iam-policy-binding", secret,
      "--project", config.project, "--member", `serviceAccount:${config.serviceAccount}`,
      "--role", "roles/secretmanager.secretAccessor", "--condition=None", "--quiet",
    ]);
  }
}

function summaryFromArguments(args) {
  if (args.length === 0) return "Claude Fable 5.1・最大推論のSlack botを更新";
  if (args.length !== 2 || args[0] !== "--summary" || !args[1].trim()) {
    throw new Error('Usage: npm run deploy -- --summary "変更内容"');
  }
  return args[1].trim();
}

export async function deploy(environment = process.env, args = process.argv.slice(2)) {
  const config = deploymentConfig(environment);
  const summary = summaryFromArguments(args);
  if (!existsSync(resolve(sourceDirectory, "package-lock.json"))) {
    throw new Error("Run npm install and the checks in claude-bot before deploying; package-lock.json is required.");
  }
  const current = serviceStatus(config);
  const gptStatus = serviceStatus(config, "gpt-slack-bot");
  config.conversationCollection = resolveSharedConversationCollection(gptStatus);
  if (environment.FIRESTORE_CONVERSATION_COLLECTION
    && environment.FIRESTORE_CONVERSATION_COLLECTION !== config.conversationCollection) {
    throw new Error(`FIRESTORE_CONVERSATION_COLLECTION must match GPT's shared collection (${config.conversationCollection}).`);
  }
  const previousCollection = serviceEnvironment(current, "FIRESTORE_CONVERSATION_COLLECTION");
  if (previousCollection && previousCollection !== config.conversationCollection) {
    console.log(`Claude will use GPT's shared conversation collection: ${previousCollection} -> ${config.conversationCollection}. Existing documents will not be migrated.`);
  }
  const channels = resolveChannels(environment, current, gptStatus);

  // Check prerequisites before creating IAM bindings or deploying a service.
  for (const secret of Object.values(secretBindings)) {
    const version = JSON.parse(gcloud([
      "secrets", "versions", "describe", "latest", "--secret", secret,
      "--project", config.project, "--format=json",
    ]));
    if (version.state !== "ENABLED") throw new Error(`Secret ${secret} needs an enabled latest version.`);
  }
  gcloud([
    "firestore", "databases", "describe", "--database=(default)",
    "--project", config.project, "--format=value(name)",
  ]);
  const token = gcloud([
    "secrets", "versions", "access", "latest", "--secret", secretBindings.SLACK_BOT_TOKEN,
    "--project", config.project,
  ]);
  const notificationSuffix = `\n追加・変更: ${summary}`;
  await notify(token, channels.channel, `🚀 claude のデプロイを開始します${notificationSuffix}`);

  try {
    ensureRuntimeAccess(config);
    gcloud(deploymentArgs(config, channels), { inherit: true });
    const status = serviceStatus(config)?.status;
    const revision = status?.latestReadyRevisionName;
    const serving = status?.traffic?.some((route) => route.revisionName === revision && route.percent === 100);
    if (!revision || revision === current?.status?.latestReadyRevisionName || !serving || !status?.url) {
      throw new Error("The new Claude revision is not confirmed to receive 100% traffic.");
    }
    console.log(`Claude service: ${status.url}`);
    console.log(`Slack Event Subscriptions Request URL: ${status.url}/slack/events`);
    await notify(token, channels.channel, `✅ claude のデプロイが完了しました\nリビジョン: ${revision}${notificationSuffix}`);
  } catch (error) {
    try {
      await notify(token, channels.channel, `❌ claude のデプロイに失敗しました${notificationSuffix}\n${error.message.slice(0, 500)}`);
    } catch (notificationError) {
      console.error(notificationError.message);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await deploy();
}
