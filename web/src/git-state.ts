import { useEffect } from "react";
import type { GitState } from "../../src/protocol/git.ts";
import { useAgentSessions, useCommand } from "@/agent-sessions.tsx";

export function useGitState(sessionId: string): { git: GitState | undefined; repository: boolean | undefined } {
  const { sessions } = useAgentSessions();
  const command = useCommand();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void command({ type: "refresh_git", sessionId }); };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [command, sessionId]);
  const session = sessions.find(session => session.id === sessionId);
  return { git: session?.git, repository: session && Boolean(session.branch || session.git) };
}
