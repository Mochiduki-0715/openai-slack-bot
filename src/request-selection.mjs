export function modelLabel(model) {
  const labels = {
    "gpt-5.6-sol": "Sol",
    "gpt-5.6-terra": "Terra",
    "gpt-5.6-luna": "Luna",
  };
  return labels[model] || model;
}

export function selectRequest(text, model) {
  const imageCommandMatch = text.match(/^image\b\s*/i);
  return {
    model,
    label: modelLabel(model),
    prompt: imageCommandMatch ? text.slice(imageCommandMatch[0].length).trim() : text,
    forceImageGeneration: Boolean(imageCommandMatch),
  };
}
