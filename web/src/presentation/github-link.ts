export function githubLinkLabel(href: string): string | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;

  const [owner, repo, kind, id] = url.pathname.split("/").filter(Boolean);
  if (!owner) return "github.com";
  if (!repo) return owner;
  if ((kind === "pull" || kind === "issues") && id) return `${owner}/${repo}#${id}`;
  if (kind === "commit" && id) return `${owner}/${repo}@${id.slice(0, 7)}`;
  return url.pathname.replace(/^\/|\/$/g, "");
}
