export const claudeModel = "claude-fable-5-1";
export const claudeModelLabel = "Fable 5.1";

const requestBudgetMs = 10 * 60 * 1000;
const maxRequestBytes = 30 * 1024 * 1024;
const maxImageBase64Bytes = 10 * 1024 * 1024;
const maxContinuations = 5;
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function requestError(message) {
  const error = new Error(message);
  error.name = "ClaudeRequestError";
  return error;
}

function sourceFromDataUrl(value, kind) {
  if (typeof value !== "string" || value.length > maxRequestBytes) {
    throw requestError("Claudeに渡す添付ファイルが不正か、リクエスト上限を超えています。");
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) {
    throw requestError("Claudeの添付ファイルには有効なbase64データURLが必要です。");
  }
  const [, mediaType, data] = match;
  const supported = kind === "image" ? imageTypes.has(mediaType) : mediaType === "application/pdf";
  if (!supported) {
    throw requestError("Claudeで解析できる添付形式はJPEG・PNG・GIF・WebP画像とPDFです。");
  }
  if (kind === "image" && data.length > maxImageBase64Bytes) {
    throw requestError("Claudeの画像はbase64エンコード後10MB以下にしてください。");
  }
  if (Buffer.from(data, "base64").toString("base64") !== data) {
    throw requestError("Claudeの添付ファイルのbase64データが不正です。");
  }
  return { type: "base64", media_type: mediaType, data };
}

function translateInput(input) {
  const items = typeof input === "string" ? [{ role: "user", content: input }] : input;
  if (!Array.isArray(items) || items.length === 0) {
    throw requestError("Claudeへの質問を指定してください。");
  }
  let imageCount = 0;
  return items.map((item) => {
    if (!item || !["user", "assistant"].includes(item.role)) {
      throw requestError("Claudeへの会話履歴の形式が不正です。");
    }
    if (typeof item.content === "string" && item.content.trim()) {
      return { role: item.role, content: item.content };
    }
    if (!Array.isArray(item.content) || item.content.length === 0) {
      throw requestError("Claudeへのメッセージ内容が空か、不正です。");
    }
    const content = item.content.map((block) => {
      if (block?.type === "input_text" && typeof block.text === "string" && block.text.trim()) {
        return { type: "text", text: block.text };
      }
      if (item.role === "user" && block?.type === "input_image") {
        imageCount += 1;
        if (imageCount > 600) throw requestError("Claudeに渡す画像は1リクエスト600件以下にしてください。");
        return { type: "image", source: sourceFromDataUrl(block.image_url, "image") };
      }
      if (item.role === "user" && block?.type === "input_file") {
        const document = { type: "document", source: sourceFromDataUrl(block.file_data, "pdf") };
        if (typeof block.filename === "string" && block.filename.trim()) document.title = block.filename;
        return document;
      }
      throw requestError("Claudeへの入力に未対応の内容が含まれています。");
    });
    return { role: item.role, content };
  });
}

function escapeSlack(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function visibleText(block) {
  if (block.type !== "text" || typeof block.text !== "string") return "";
  const links = new Set();
  for (const citation of block.citations ?? []) {
    if (citation?.type !== "web_search_result_location") continue;
    let url;
    try {
      url = new URL(citation.url);
    } catch {
      continue;
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
    const title = typeof citation.title === "string" && citation.title.trim() ? citation.title : url.hostname;
    links.add(`<${escapeSlack(url.href.replaceAll("|", "%7C"))}|${escapeSlack(title.replaceAll("|", "｜").replace(/\s+/g, " "))}>`);
  }
  return `${block.text}${links.size ? ` ${[...links].join(" ")}` : ""}`;
}

function assertResponse(response) {
  if (!Array.isArray(response?.content)) throw requestError("Claudeから有効な応答を取得できませんでした。");
  for (const block of response.content) {
    if (block?.type === "tool_use") throw requestError("Claudeが未対応のツール実行を要求しました。");
    if (block?.type === "web_search_tool_result" && !Array.isArray(block.content)) {
      const code = block.content?.error_code;
      const knownCodes = new Set(["too_many_requests", "invalid_tool_input", "max_uses_exceeded", "query_too_long", "request_too_large", "unavailable"]);
      throw requestError(`ClaudeのWeb検索に失敗しました（${knownCodes.has(code) ? code : "search_error"}）。`);
    }
  }
  if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") {
    throw requestError("Claudeの解析がトークン上限で中断されました。質問や添付資料を分割してください。");
  }
  if (response.stop_reason === "refusal") throw requestError("Claudeはこのリクエストへの回答を拒否しました。");
  if (!["end_turn", "pause_turn"].includes(response.stop_reason)) {
    throw requestError("Claudeの回答が正常に完了しませんでした。");
  }
}

export async function createClaudeResponse(client, { instructions, input } = {}) {
  if (instructions !== undefined && typeof instructions !== "string") {
    throw requestError("Claudeへの指示は文字列で指定してください。");
  }
  const startedAt = Date.now();
  const messages = translateInput(input);
  const request = {
    model: claudeModel,
    max_tokens: 64000,
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "max" },
    ...(instructions ? { system: instructions } : {}),
    messages,
    tools: [{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"], max_uses: 5 }],
  };
  const controller = new AbortController();
  const timeoutError = requestError("Claudeの解析が10分の制限時間を超えました。質問や添付資料を分割してください。");
  const timer = setTimeout(() => controller.abort(timeoutError), requestBudgetMs);
  timer.unref();
  const text = [];
  try {
    for (let continuation = 0; continuation <= maxContinuations; continuation += 1) {
      const remainingMs = requestBudgetMs - (Date.now() - startedAt);
      if (remainingMs <= 0 || controller.signal.aborted) throw timeoutError;
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > maxRequestBytes) {
        throw requestError("Claudeへのリクエストが30MBを超えています。添付資料や会話を分割してください。");
      }
      const response = await client.messages.stream(request, {
        timeout: remainingMs,
        signal: controller.signal,
        maxRetries: 0,
      }).finalMessage();
      if (controller.signal.aborted || Date.now() - startedAt >= requestBudgetMs) throw timeoutError;
      assertResponse(response);
      text.push(...response.content.map(visibleText).filter((part) => part.trim()));
      if (response.stop_reason === "end_turn") {
        const outputText = text.join("\n\n").trim();
        if (!outputText) throw requestError("Claudeから回答本文を取得できませんでした。");
        return { output_text: outputText, output: [] };
      }
      if (continuation === maxContinuations) {
        throw requestError("ClaudeのWeb検索が継続回数の上限に達しました。質問を絞って再度お試しください。");
      }
      // Preserve server-tool results and signed thinking exactly for continuation.
      messages.push({ role: "assistant", content: response.content });
    }
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
