import { useEffect, useState } from "react";
import type { GitState } from "../../src/protocol/git.ts";
import { useAgentSessions, useCommand } from "@/agent-sessions.tsx";

export function useGitState(sessionId: string): { git: GitState | undefined; repository: boolean | undefined } {
  const { sessions } = useAgentSessions();
  const command = useCommand();
  const [answer, setAnswer] = useState<{ sessionId: string; repository: boolean }>();
  useEffect(() => {
    let current = true;
    const refresh = () => {
      if (document.visibilityState === "visible") void command<{ repository: boolean }>({ type: "refresh_git", sessionId }).then(result => { if (current && result) setAnswer({ sessionId, repository: result.repository }); });
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [command, sessionId]);
  const git = sessions.find(session => session.id === sessionId)?.git;
  return { git, repository: git ? true : answer?.sessionId === sessionId ? answer.repository : undefined };
}
