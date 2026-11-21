export function parsePiModelConfig(content: string): unknown {
  return JSON.parse(content.replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match.startsWith('"') ? match : "")
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, closing: string | undefined) => closing ?? match));
}
