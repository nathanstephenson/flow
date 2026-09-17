export function leadingSkillToken(text: string): { name: string; to: number } | undefined {
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([A-Za-z0-9][\w-]*(?::(?:[A-Za-z0-9][\w-]*)?)?)?/.exec(text);
  const name = match?.[1] ?? "";
  return { name, to: name.length + 1 };
}

export function leadingSkillInvocation(
  text: string,
): { name: string; to: number; rest: string } | undefined {
  const token = leadingSkillToken(text);
  if (!token || token.name === "" || token.name.endsWith(":")) return undefined;
  const next = text[token.to];
  if (next !== undefined && next !== " " && next !== "\n") return undefined;
  return { ...token, rest: text.slice(token.to) };
}
