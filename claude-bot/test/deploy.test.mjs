import assert from "node:assert/strict";
import { isMissingResourceError } from "../scripts/deploy.mjs";
import test from "node:test";

test("recognizes Cloud Run's first-deployment missing-service error without masking access failures", () => {
  assert.equal(isMissingResourceError("ERROR: (gcloud.run.services.describe) Cannot find service [claude-slack-bot]"), true);
  assert.equal(isMissingResourceError("ERROR: NOT_FOUND: Service account was not found."), true);
  assert.equal(isMissingResourceError("ERROR: PERMISSION_DENIED: Cannot access service [claude-slack-bot]"), false);
  assert.equal(isMissingResourceError("ERROR: Connection timed out"), false);
});
import { fileURLToPath } from "node:url";
import { deploymentArgs, deploymentConfig, resolveChannels, resolveSharedConversationCollection } from "../scripts/deploy.mjs";

function serviceWith(environment) {
  return { spec: { template: { spec: { containers: [{ env: Object.entries(environment).map(([name, value]) => ({ name, value })) }] } } } };
}

function argument(args, name) {
  const index = args.indexOf(name);
  assert.ok(index >= 0, `${name} must be present`);
  return args[index + 1];
}

test("keeps the Claude target isolated even when generic GPT deployment variables are inherited", () => {
  const config = deploymentConfig({ CLOUD_RUN_SERVICE: "gpt-slack-bot", CLOUD_RUN_SERVICE_ACCOUNT: "gpt-slack-bot@example.invalid" });
  assert.equal(config.service, "claude-slack-bot");
  assert.equal(config.serviceAccount, `claude-slack-bot@${config.project}.iam.gserviceaccount.com`);
  assert.equal(config.conversationCollection, "slack_conversations");
  const custom = deploymentConfig({ GOOGLE_CLOUD_PROJECT: "another-project", CLOUD_RUN_REGION: "asia-northeast2" });
  assert.equal(custom.project, "another-project");
  assert.equal(custom.region, "asia-northeast2");
  assert.equal(custom.serviceAccount, "claude-slack-bot@another-project.iam.gserviceaccount.com");
});

test("uses GPT's actual conversation collection and requires the existing service", () => {
  assert.equal(resolveSharedConversationCollection(serviceWith({})), "slack_conversations");
  assert.equal(resolveSharedConversationCollection(serviceWith({ FIRESTORE_CONVERSATION_COLLECTION: "custom_shared_history" })), "custom_shared_history");
  assert.throws(() => resolveSharedConversationCollection(undefined), /existing gpt-slack-bot/);
});

test("first deployment inherits channels from GPT while updates prefer Claude's own settings", () => {
  const gpt = serviceWith({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "C123", ALLOWED_CHANNEL_IDS: "C123,G456" });
  const claude = serviceWith({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "C789", ALLOWED_CHANNEL_IDS: "C789" });
  assert.deepEqual(resolveChannels({}, undefined, gpt), { channel: "C123", allowedChannels: "C123,G456" });
  assert.deepEqual(resolveChannels({}, claude, gpt), { channel: "C789", allowedChannels: "C789" });
  assert.deepEqual(resolveChannels({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "C987", ALLOWED_CHANNEL_IDS: " C987, G321 " }, claude, gpt), { channel: "C987", allowedChannels: "C987,G321" });
});

test("defaults to the notification channel without an allowlist and preserves an explicit all-channel setting", () => {
  assert.deepEqual(resolveChannels({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "C123" }), { channel: "C123", allowedChannels: "C123" });
  assert.deepEqual(resolveChannels({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "C123", ALLOWED_CHANNEL_IDS: "" }), { channel: "C123", allowedChannels: "" });
});

test("rejects missing channel configuration and values that would corrupt deployment arguments", () => {
  assert.throws(() => resolveChannels({}), /DEPLOYMENT_NOTIFICATION_CHANNEL_ID/);
  assert.throws(() => resolveChannels({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "#general" }), /DEPLOYMENT_NOTIFICATION_CHANNEL_ID/);
  assert.throws(() => resolveChannels({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "C123", ALLOWED_CHANNEL_IDS: "C123|OTHER=value" }), /ALLOWED_CHANNEL_IDS/);
  assert.throws(() => resolveChannels({ DEPLOYMENT_NOTIFICATION_CHANNEL_ID: "C123", ALLOWED_CHANNEL_IDS: "C123\nOTHER=value" }), /ALLOWED_CHANNEL_IDS/);
});

test("deployment sends only the Claude directory and its dedicated credentials to the Claude service", () => {
  const config = deploymentConfig({});
  const args = deploymentArgs(config, { channel: "C123", allowedChannels: "C123,G456" });
  assert.deepEqual(args.slice(0, 3), ["run", "deploy", "claude-slack-bot"]);
  assert.equal(argument(args, "--source"), fileURLToPath(new URL("../", import.meta.url)));
  assert.equal(argument(args, "--service-account"), config.serviceAccount);
  assert.deepEqual(argument(args, "--set-secrets").split(",").sort(), [
    "ANTHROPIC_API_KEY=anthropic-api-key:latest",
    "SLACK_BOT_TOKEN=claude-slack-bot-token:latest",
    "SLACK_SIGNING_SECRET=claude-slack-signing-secret:latest",
  ].sort());
  assert.ok(!args.some((value) => value.includes("OPENAI_")));
});

test("deployment preserves shared-history configuration and comma-separated channel IDs", () => {
  const config = { ...deploymentConfig({}), conversationCollection: resolveSharedConversationCollection(serviceWith({ FIRESTORE_CONVERSATION_COLLECTION: "custom_shared_history" })) };
  const args = deploymentArgs(config, { channel: "C123", allowedChannels: "C123,G456" });
  const envArgument = argument(args, "--set-env-vars");
  assert.ok(envArgument.startsWith("^|^"));
  const environments = Object.fromEntries(envArgument.slice(3).split("|").map((part) => part.split("=")));
  assert.equal(environments.FIRESTORE_CONVERSATION_COLLECTION, "custom_shared_history");
  assert.equal(environments.ALLOWED_CHANNEL_IDS, "C123,G456");
  assert.equal(environments.DEPLOYMENT_NOTIFICATION_CHANNEL_ID, "C123");
  assert.ok(args.includes("--no-cpu-throttling"));
});
