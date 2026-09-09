import { setTimeout as delay } from "node:timers/promises";

const minimumStartIntervalMs = 1000;
const throttleBudgetMs = 60_000;
const maxRateLimitRetries = 3;
const rateLimitedErrorCode = "slack_webapi_rate_limited_error";

function postingError(message, code) {
  const error = new Error(message);
  error.name = "SlackPostingError";
  error.code = code;
  return error;
}

export function createSlackPoster({ sleep = delay, now = Date.now } = {}) {
  const channels = new Map();
  // Slack's Retry-After can apply to this API method across the workspace.
  let rateLimitedUntil = 0;

  return async function postSlackMessage(client, options) {
    if (typeof options?.channel !== "string" || !options.channel.trim()) {
      throw new TypeError("A Slack channel is required to post a message.");
    }
    const deadline = now() + throttleBudgetMs;
    let state = channels.get(options.channel);
    if (!state) {
      state = { tail: Promise.resolve(), nextStartAt: 0 };
      channels.set(options.channel, state);
    }
    const send = async () => {
      let retries = 0;
      while (true) {
        const current = now();
        const waitMs = Math.max(state.nextStartAt, rateLimitedUntil) - current;
        if (current >= deadline || current + Math.max(0, waitMs) >= deadline) {
          throw postingError("Slackへの投稿待機が60秒の上限に達しました。", "slack_posting_deadline");
        }
        if (waitMs > 0) {
          await sleep(waitMs);
          continue;
        }
        state.nextStartAt = current + minimumStartIntervalMs;
        try {
          return await client.chat.postMessage(options);
        } catch (error) {
          // Network failures may already have delivered the message. Only retry
          // the explicit rate-limit response, which did not accept the message.
          if (error?.code !== rateLimitedErrorCode) throw error;
          if (!Number.isFinite(error.retryAfter) || error.retryAfter < 0) throw error;
          rateLimitedUntil = Math.max(rateLimitedUntil, now() + Math.ceil(error.retryAfter * 1000));
          if (retries >= maxRateLimitRetries) {
            throw postingError("Slackへの投稿がレート制限の再試行上限に達しました。", "slack_posting_retry_limit");
          }
          retries += 1;
        }
      }
    };
    const result = state.tail.then(send);
    state.tail = result.catch(() => {});
    return result;
  };
}

export const postSlackMessage = createSlackPoster();
