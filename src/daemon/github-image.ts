const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isGithubImage(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.hostname === "raw.githubusercontent.com") return /^\/[^/]+\/[^/]+\/.+/.test(url.pathname);
  return url.hostname === "github.com" && /^\/user-attachments\/assets\/[0-9a-f-]+$/i.test(url.pathname);
}

export async function githubImage(href: string, token: () => Promise<string>, fetcher: typeof fetch = fetch): Promise<Response | null> {
  if (!URL.canParse(href) || !isGithubImage(new URL(href))) return null;
  const response = await fetcher(href, { headers: { authorization: `token ${(await token()).trim()}` } });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (response.ok && TYPES.has(type)) return response;
  await response.body?.cancel();
  return null;
}
