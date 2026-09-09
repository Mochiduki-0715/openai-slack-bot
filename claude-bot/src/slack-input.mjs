const maxAttachmentBytes = 20 * 1024 * 1024;
const supportedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
const sizeLimitMessage = "添付ファイルは1メッセージあたり合計20MiB以下にしてください。";

export class SlackInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SlackInputError";
  }
}

function isYouTubeVideoUrl(candidate) {
  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be" || host === "www.youtu.be") {
      return url.pathname !== "/";
    }
    if (!/^(?:(?:www|m|music)\.)?youtube(?:-nocookie)?\.com$/.test(host)) {
      return false;
    }
    return (
      (url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) ||
      /^\/(?:shorts|live|embed|v)\/[^/]+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function validatePrompt(prompt) {
  const text = String(prompt ?? "").trim();
  if (/^image\b/i.test(text)) {
    throw new SlackInputError(
      "Claude botでは画像生成に対応していません。会話・Web検索・添付画像やPDFの読取りを利用できます。",
    );
  }
  const urls = text.match(
    /\bhttps?:\/\/[^\s<>|]+|(?<![\w./-])(?:(?:www|m|music)\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be)\/[^\s<>|]*/gi,
  ) ?? [];
  if (urls.some(isYouTubeVideoUrl)) {
    throw new SlackInputError(
      "Claude botではYouTube動画の解析に対応していません。内容のテキスト、画像、またはPDFを添付してください。",
    );
  }
  return text;
}

function trustedSlackUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".slack.com") ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      throw new Error("Untrusted Slack download URL");
    }
    return url.href;
  } catch {
    throw new SlackInputError("添付ファイルのSlackダウンロードURLを確認できません。ファイルを再添付してください。");
  }
}

async function readBoundedBody(response, remainingBytes, signal) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > remainingBytes) {
    await response.body?.cancel().catch(() => {});
    throw new SlackInputError(sizeLimitMessage);
  }
  if (!response.body) {
    throw new SlackInputError("添付ファイルの内容を取得できませんでした。ファイルを再添付してください。");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let completed = false;
  const abortRead = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abortRead, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        completed = true;
        break;
      }
      size += value.byteLength;
      if (size > remainingBytes) throw new SlackInputError(sizeLimitMessage);
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", abortRead);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0) {
    throw new SlackInputError("添付ファイルが空です。内容のある画像またはPDFを添付してください。");
  }
  return Buffer.concat(chunks, size);
}

export async function slackFileInputs(
  client,
  event,
  { fetchImpl = fetch, token = process.env.SLACK_BOT_TOKEN, downloadTimeoutMs = 120_000 } = {},
) {
  const files = event?.files ?? [];
  if (!Array.isArray(files)) {
    throw new SlackInputError("添付ファイル情報を取得できませんでした。ファイルを再添付してください。");
  }
  if (files.length === 0) return [];
  if (!token) {
    throw new SlackInputError("添付ファイルを取得するためのSlack認証が設定されていません。");
  }

  const attachments = [];
  let declaredBytes = 0;
  for (const file of files) {
    if (!file?.id) {
      throw new SlackInputError("添付ファイルのIDを取得できませんでした。ファイルを再添付してください。");
    }
    let result;
    try {
      result = await client.files.info({ file: file.id });
    } catch (cause) {
      throw new SlackInputError("添付ファイル情報を取得できませんでした。Slackのファイル閲覧権限を確認してください。", { cause });
    }
    const metadata = result?.file;
    if (result?.ok === false || !metadata?.mimetype) {
      throw new SlackInputError("添付ファイル情報を取得できませんでした。ファイルを再添付してください。");
    }
    const mimeType = metadata.mimetype.toLowerCase();
    if (!supportedMimeTypes.has(mimeType)) {
      throw new SlackInputError(
        "Claude botで読取りできる添付はJPEG・PNG・GIF・WebPの画像とPDFです。音声・動画などには対応していません。",
      );
    }
    const declaredSize = Number(metadata.size ?? 0);
    if (!Number.isFinite(declaredSize) || declaredSize < 0) {
      throw new SlackInputError("添付ファイルのサイズを確認できませんでした。ファイルを再添付してください。");
    }
    declaredBytes += declaredSize;
    if (declaredBytes > maxAttachmentBytes) throw new SlackInputError(sizeLimitMessage);
    const downloadUrl = metadata.url_private_download || metadata.url_private;
    if (!downloadUrl) {
      throw new SlackInputError("添付ファイルの非公開ダウンロードURLを取得できませんでした。ファイルを再添付してください。");
    }
    attachments.push({
      mimeType,
      url: trustedSlackUrl(downloadUrl),
      filename: metadata.name || file.name || `slack-${file.id}.pdf`,
    });
  }

  const inputs = [];
  let downloadedBytes = 0;
  const controller = new AbortController();
  const timeoutError = new SlackInputError("添付ファイルのダウンロードが制限時間を超えました。ファイルを小さくするか、時間をおいて再度お試しください。");
  const timer = setTimeout(() => controller.abort(timeoutError), downloadTimeoutMs);
  try {
    for (const attachment of attachments) {
      let bytes;
      try {
        controller.signal.throwIfAborted();
        const response = await fetchImpl(attachment.url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: controller.signal,
        });
        if (response.redirected || (response.url && trustedSlackUrl(response.url) !== attachment.url)) {
          await response.body?.cancel().catch(() => {});
          throw new SlackInputError("添付ファイルのダウンロード先が変更されました。ファイルを再添付してください。");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new SlackInputError(`添付ファイルをダウンロードできませんでした（HTTP ${response.status}）。`);
        }
        bytes = await readBoundedBody(response, maxAttachmentBytes - downloadedBytes, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) throw timeoutError;
        if (cause instanceof SlackInputError) throw cause;
        throw new SlackInputError("添付ファイルをダウンロードできませんでした。時間をおいて再度お試しください。", { cause });
      }
      downloadedBytes += bytes.length;
      const data = `data:${attachment.mimeType};base64,${bytes.toString("base64")}`;
      inputs.push(attachment.mimeType === "application/pdf"
        ? { type: "input_file", filename: attachment.filename, file_data: data }
        : { type: "input_image", image_url: data });
    }
    return inputs;
  } finally {
    clearTimeout(timer);
  }
}
