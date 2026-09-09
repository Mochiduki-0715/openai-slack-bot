export const botModel = "gpt-6-astra";
export const botModelLabel = "Astra";

export function createBotResponse(openai, options) {
  return openai.responses.create({
    ...options,
    model: botModel,
    reasoning: { mode: "pro", effort: "max" },
  });
}
