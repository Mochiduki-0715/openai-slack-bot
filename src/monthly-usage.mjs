const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

function tokyoParts(date) {
  const shifted = new Date(date.getTime() + TOKYO_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
  };
}

export function previousMonthRange(now = new Date()) {
  const { year, month } = tokyoParts(now);
  const previous = new Date(Date.UTC(year, month - 1, 1));
  const next = new Date(Date.UTC(year, month, 1));
  const startTime = Math.floor((previous.getTime() - TOKYO_OFFSET_MS) / 1000);
  const endTime = Math.floor((next.getTime() - TOKYO_OFFSET_MS) / 1000);

  return {
    yearMonth: `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`,
    startTime,
    endTime,
  };
}

export async function fetchOpenAICosts({ apiKey, startTime, endTime, projectId, fetchImpl = fetch }) {
  let cursor;
  let amount = 0;
  let currency = "usd";

  do {
    const params = new URLSearchParams({
      start_time: String(startTime),
      end_time: String(endTime),
      bucket_width: "1d",
      limit: "180",
    });
    if (projectId) params.append("project_ids", projectId);
    if (cursor) params.set("page", cursor);

    const response = await fetchImpl(`https://api.openai.com/v1/organization/costs?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI Costs API failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const page = await response.json();
    for (const bucket of page.data || []) {
      for (const result of bucket.results || []) {
        const value = Number(result.amount?.value);
        if (Number.isFinite(value)) amount += value;
        if (result.amount?.currency) currency = result.amount.currency;
      }
    }
    cursor = page.has_more ? page.next_page : undefined;
  } while (cursor);

  return { amount, currency };
}

export function formatUsageAmount(amount, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}

export function monthlyUsageMessage(usage) {
  return `*OpenAI API 利用状況*\n前月の利用額: ${formatUsageAmount(usage.amount, usage.currency)}`;
}
