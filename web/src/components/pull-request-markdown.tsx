import { useMemo } from "react";
import { parseMarkdown } from "@client/markdown.ts";
import { Markdown } from "@/components/markdown.tsx";

export function PullRequestMarkdown({ body, repo, headRefName }: { body: string; repo: string; headRefName: string }) {
  const blocks = useMemo(() => parseMarkdown(body, {
    images: true,
    linkBase: `https://github.com/${repo}/blob/${encodeURIComponent(headRefName)}/`,
    imageBase: `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(headRefName)}/`,
  }), [body, repo, headRefName]);
  return <Markdown blocks={blocks} query="" />;
}
