export function selectRequest(text) {
  const imageCommandMatch = text.match(/^image\b\s*/i);
  return {
    prompt: imageCommandMatch ? text.slice(imageCommandMatch[0].length).trim() : text,
    forceImageGeneration: Boolean(imageCommandMatch),
  };
}
