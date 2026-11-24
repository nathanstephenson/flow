export function githubLinkLabel(href: string): string | undefined {
  const path = githubPath(href);
  if (path === undefined) return undefined;

  const [owner, repo, kind, id] = path;
  if (!owner) return "github.com";
  if (!repo) return owner;
  if ((kind === "pull" || kind === "issues") && id) return `${owner}/${repo}#${id}`;
  if (kind === "commit" && id) return `${owner}/${repo}@${id.slice(0, 7)}`;
  return path.join("/");
}

export function samePullRequest(href: string, pullRequestUrl: string): boolean {
  const link = pullRequestKey(href);
  return link !== undefined && link === pullRequestKey(pullRequestUrl);
}

function pullRequestKey(href: string): string | undefined {
  const [owner, repo, kind, id] = githubPath(href) ?? [];
  return kind === "pull" && id ? `${owner}/${repo}/${id}`.toLowerCase() : undefined;
}

function githubPath(href: string): string[] | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
  return url.pathname.split("/").filter(Boolean);
}
