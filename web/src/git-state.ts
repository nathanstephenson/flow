import { useEffect } from "react";
import type { GitState } from "../../src/protocol/git.ts";
import { useAgentSessions, useCommand } from "@/agent-sessions.tsx";

export function useGitState(sessionId: string): GitState | undefined {
  const { sessions } = useAgentSessions();
  const command = useCommand();
  useEffect(() => { void command({ type: "refresh_git", sessionId }); }, [command, sessionId]);
  return sessions.find(session => session.id === sessionId)?.git;
}
