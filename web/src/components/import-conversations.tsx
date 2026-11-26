import { useCallback, useEffect, useRef, useState } from "react";

import type { ImportableConversation, ImportMode } from "../../../src/protocol/imports.ts";
import { relativeTime } from "../../../src/client/relative-time.ts";
import { useCommand } from "@/agent-sessions.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { backendLabel } from "@/components/settings-providers.tsx";

export function importSourceLabel(backend: string): string {
  return backend === "claude" ? "Claude Code" : backendLabel(backend);
}

/**
 * The Chat tab's Import section: the conversations the chosen backend's own tool recorded in the
 * chosen Project, each importable to continue or to read (ADR 0047).
 *
 * Listed per Project rather than machine-wide, because the tool keys its conversations by the
 * directory it ran in and an Agent Session is bound to its Scope for life — a conversation from
 * elsewhere could not be continued here anyway.
 */
export function ImportConversations({
  backend,
  scope,
  projectName,
  onImported,
}: {
  backend: string;
  scope: string | undefined;
  projectName: string | undefined;
  onImported: (sessionId: string) => void;
}) {
  const run = useCommand();
  // Read through a ref by the listing effect, which has to rerun when the Project changes and not
  // whenever `useCommand` hands back a new function — that would list again on every render.
  const listWith = useRef(run);
  listWith.current = run;
  /** `null` when the listing failed, which must not read as a Project with nothing in it. */
  const [conversations, setConversations] = useState<ImportableConversation[] | null | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [importing, setImporting] = useState<string | undefined>();

  useEffect(() => {
    setConversations(undefined);
    if (scope === undefined) return;
    // Dropped if the Project changes before it answers, so a slow listing for the last Project
    // cannot replace the one for this.
    let current = true;
    void listWith.current<ImportableConversation[]>({ type: "list_imports", backend, scope }).then((listed) => {
      if (current) setConversations(listed ?? null);
    });
    return () => {
      current = false;
    };
  }, [backend, scope, attempt]);

  const bring = useCallback(
    async (conversation: ImportableConversation, mode: ImportMode) => {
      if (scope === undefined || importing) return;
      setImporting(conversation.id);
      try {
        const created = await run<string>({ type: "import", backend, scope, conversationId: conversation.id, mode });
        if (created) onImported(created);
      } finally {
        setImporting(undefined);
      }
    },
    [backend, importing, onImported, run, scope],
  );

  const source = importSourceLabel(backend);
  if (scope === undefined) {
    return <p className="text-center text-sm text-muted-foreground">Choose a Project to see the {source} conversations recorded in it.</p>;
  }
  if (conversations === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <span>Could not list the {source} conversations in {projectName ?? "this Project"}.</span>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((count) => count + 1)}>Try again</Button>
      </div>
    );
  }
  if (conversations === undefined) {
    return <p className="text-sm text-muted-foreground">Looking for {source} conversations…</p>;
  }
  if (conversations.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {source} has recorded no conversations in {projectName ?? "this Project"}.
      </p>
    );
  }

  return (
    <ul className="grid gap-2" aria-label={`${source} conversations`}>
      {conversations.map((conversation) => (
        <li key={conversation.id} className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{conversation.title}</span>
              {conversation.importedAs ? <Badge variant="secondary">Imported</Badge> : null}
            </div>
            <span className="text-xs text-muted-foreground">
              {relativeTime(conversation.updatedAt)} · {conversation.prompts} {conversation.prompts === 1 ? "prompt" : "prompts"}
            </span>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" disabled={importing !== undefined} onClick={() => void bring(conversation, "view")}>
              Read only
            </Button>
            <Button size="sm" disabled={importing !== undefined} onClick={() => void bring(conversation, "continue")}>
              {importing === conversation.id ? "Importing…" : "Continue"}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
