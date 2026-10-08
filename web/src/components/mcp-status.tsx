import { useState } from "react";
import type { McpStatus } from "../../../src/protocol/mcp.ts";
import { useHost } from "@/host.tsx";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { signInMcp } from "./mcp-actions.ts";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./ui/dropdown-menu.tsx";
import { toast } from "./ui/toaster.tsx";

export function useMcpConnectionStatus(sessionId: string) {
  const { data } = useWorkflowResource<McpStatus[]>(
    `/api/sessions/${sessionId}/mcp`,
  );
  const [busy, setBusy] = useState(false);
  const retry = (id: string) => {
    setBusy(true);
    void workflowApi(`/api/sessions/${sessionId}/mcp/${id}/retry`, "POST")
      .catch((error) => toast.error(String(error)))
      .finally(() => setBusy(false));
  };
  return { data, busy, retry };
}

export function McpConnectionMenu({ data, busy, retry }: ReturnType<typeof useMcpConnectionStatus>) {
  const { config } = useHost();
  if (!data?.length) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        MCP · {data.filter((entry) => entry.state === "connected").length}/
        {data.length} connected
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {data.map((entry) => {
          const connection = config.mcp?.find(
            (connection) => connection.id === entry.id,
          );
          const label = `${connection?.name ?? entry.id}: ${entry.state}${
            entry.state === "connected" ? ` (${entry.tools} tools)` : ""
          }`;
          if (entry.state !== "failed") {
            return (
              <DropdownMenuItem key={entry.id} disabled>
                {label}
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuSub key={entry.id}>
              <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {connection?.transport === "http" && connection.oauth && (
                  <DropdownMenuItem onClick={() => void signInMcp(entry.id)}>
                    Sign in
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={busy}
                  onClick={() => retry(entry.id)}
                >
                  Retry
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
