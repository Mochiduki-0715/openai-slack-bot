import { execFileSync, spawnSync } from "node:child_process";

const project = process.env.GOOGLE_CLOUD_PROJECT || "mochiduki-gpt-slack-260713";
const region = process.env.CLOUD_RUN_REGION || "asia-northeast1";
const service = process.env.CLOUD_RUN_SERVICE || "gpt-slack-bot";
const worker = process.env.MEDIA_WORKER_SERVICE || `${service}-media-worker`;
const runtimeServiceAccount =
  process.env.CLOUD_RUN_SERVICE_ACCOUNT || `gpt-slack-bot@${project}.iam.gserviceaccount.com`;
const taskServiceAccount =
  process.env.MEDIA_TASK_SERVICE_ACCOUNT || `${service}-media-task@${project}.iam.gserviceaccount.com`;
const queue = process.env.MEDIA_TASK_QUEUE || "gpt-slack-media";
const bindWorker = process.argv.includes("--bind-worker");

function run(args, options = {}) {
  const result = spawnSync("gcloud", args, { stdio: "inherit", ...options });
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

run(["services", "enable", "cloudtasks.googleapis.com", "--project", project, "--quiet"]);

for (const collectionGroup of ["media_jobs", "transcript_chunks", "media_usage"]) {
  run([
    "firestore",
    "fields",
    "ttls",
    "update",
    "expiresAt",
    "--collection-group",
    collectionGroup,
    "--enable-ttl",
    "--async",
    "--project",
    project,
    "--quiet",
  ]);
}

if (!exists(["iam", "service-accounts", "describe", taskServiceAccount, "--project", project])) {
  run(["iam", "service-accounts", "create", taskServiceAccount.split("@")[0], "--project", project, "--quiet"]);
}
if (!exists(["tasks", "queues", "describe", queue, "--location", region, "--project", project])) {
  run([
    "tasks",
    "queues",
    "create",
    queue,
    "--location",
    region,
    "--project",
    project,
    "--max-concurrent-dispatches=1",
    "--max-attempts=1",
    "--quiet",
  ]);
}

run([
  "projects",
  "add-iam-policy-binding",
  project,
  "--member",
  `serviceAccount:${runtimeServiceAccount}`,
  "--role",
  "roles/cloudtasks.enqueuer",
  "--quiet",
]);
run([
  "iam",
  "service-accounts",
  "add-iam-policy-binding",
  taskServiceAccount,
  "--member",
  `serviceAccount:${runtimeServiceAccount}`,
  "--role",
  "roles/iam.serviceAccountUser",
  "--project",
  project,
  "--quiet",
]);

const projectNumber = output(["projects", "describe", project, "--format=value(projectNumber)"]);
run([
  "iam",
  "service-accounts",
  "add-iam-policy-binding",
  taskServiceAccount,
  "--member",
  `serviceAccount:service-${projectNumber}@gcp-sa-cloudtasks.iam.gserviceaccount.com`,
  "--role",
  "roles/iam.serviceAccountTokenCreator",
  "--project",
  project,
  "--quiet",
]);

if (bindWorker) {
  run([
    "run",
    "services",
    "add-iam-policy-binding",
    worker,
    "--region",
    region,
    "--project",
    project,
    "--member",
    `serviceAccount:${taskServiceAccount}`,
    "--role",
    "roles/run.invoker",
    "--quiet",
  ]);
}

console.log(`Media processing setup is ready for queue ${queue}.`);
