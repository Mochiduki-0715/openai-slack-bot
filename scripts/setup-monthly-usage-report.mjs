import { execFileSync, spawnSync } from "node:child_process";

const project = process.env.GOOGLE_CLOUD_PROJECT || "mochiduki-gpt-slack-260713";
const region = process.env.CLOUD_RUN_REGION || "asia-northeast1";
const service = process.env.CLOUD_RUN_SERVICE || "gpt-slack-bot";
const runtimeServiceAccount =
  process.env.CLOUD_RUN_SERVICE_ACCOUNT || `gpt-slack-bot@${project}.iam.gserviceaccount.com`;
const schedulerServiceAccount =
  process.env.MONTHLY_USAGE_SCHEDULER_SERVICE_ACCOUNT ||
  `gpt-monthly-usage-scheduler@${project}.iam.gserviceaccount.com`;
const schedulerJob = process.env.MONTHLY_USAGE_SCHEDULER_JOB || "gpt-slack-monthly-usage";
const usageSecret = process.env.OPENAI_USAGE_SECRET || "openai-usage-admin-key";

function run(args) {
  const result = spawnSync("gcloud", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gcloud ${args.join(" ")} exited with ${result.status}.`);
}

function output(args) {
  return execFileSync("gcloud", args, { encoding: "utf8" }).trim();
}

function exists(args) {
  try {
    output(args);
    return true;
  } catch {
    return false;
  }
}

run(["services", "enable", "cloudscheduler.googleapis.com", "--project", project, "--quiet"]);

if (!exists(["secrets", "describe", usageSecret, "--project", project])) {
  throw new Error(
    `Secret ${usageSecret} is required. Store an OpenAI Admin key with the api.usage.read scope in Secret Manager first.`,
  );
}

if (!exists(["iam", "service-accounts", "describe", schedulerServiceAccount, "--project", project])) {
  run([
    "iam",
    "service-accounts",
    "create",
    schedulerServiceAccount.split("@")[0],
    "--project",
    project,
    "--quiet",
  ]);
}

run([
  "secrets",
  "add-iam-policy-binding",
  usageSecret,
  "--project",
  project,
  "--member",
  `serviceAccount:${runtimeServiceAccount}`,
  "--role",
  "roles/secretmanager.secretAccessor",
  "--quiet",
]);
run([
  "run",
  "services",
  "add-iam-policy-binding",
  service,
  "--region",
  region,
  "--project",
  project,
  "--member",
  `serviceAccount:${schedulerServiceAccount}`,
  "--role",
  "roles/run.invoker",
  "--quiet",
]);

const projectNumber = output(["projects", "describe", project, "--format=value(projectNumber)"]);
run([
  "iam",
  "service-accounts",
  "add-iam-policy-binding",
  schedulerServiceAccount,
  "--member",
  `serviceAccount:service-${projectNumber}@gcp-sa-cloudscheduler.iam.gserviceaccount.com`,
  "--role",
  "roles/iam.serviceAccountTokenCreator",
  "--project",
  project,
  "--quiet",
]);

const serviceUrl = output([
  "run",
  "services",
  "describe",
  service,
  "--region",
  region,
  "--project",
  project,
  "--format=value(status.url)",
]);
const jobArgs = [
  "scheduler",
  "jobs",
  exists(["scheduler", "jobs", "describe", schedulerJob, "--location", region, "--project", project])
    ? "update"
    : "create",
  "http",
  schedulerJob,
  "--location",
  region,
  "--project",
  project,
  "--schedule",
  "0 9 1 * *",
  "--time-zone",
  "Asia/Tokyo",
  "--uri",
  `${serviceUrl}/internal/monthly-usage`,
  "--http-method",
  "POST",
  "--oidc-service-account-email",
  schedulerServiceAccount,
  "--oidc-token-audience",
  serviceUrl,
  "--quiet",
];
run(jobArgs);

console.log(`Monthly OpenAI usage report is scheduled for 09:00 JST on the first day of each month (${schedulerJob}).`);
