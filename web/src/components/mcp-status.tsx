import { useState } from "react";
import type { McpStatus } from "../../../src/protocol/mcp.ts";
import { useHost } from "@/host.tsx";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { signInMcp } from "./mcp-actions.ts";
import { Button } from "./ui/button.tsx";
import { toast } from "./ui/toaster.tsx";

export function McpConnectionStatus({ sessionId }: { sessionId: string }) {
  const { config } = useHost();
  const { data } = useWorkflowResource<McpStatus[]>(
    `/api/sessions/${sessionId}/mcp`,
  );
  const [busy, setBusy] = useState(false);
  if (!data?.length) return null;
  return (
    <details className="border-b px-4 py-2 text-xs text-muted-foreground">
      <summary>
        MCP · {data.filter((entry) => entry.state === "connected").length}/
        {data.length} connected
      </summary>
      {data.map((entry) => {
        const connection = config.mcp?.find(
          (connection) => connection.id === entry.id,
        );
        return (
          <div key={entry.id} className="flex items-center gap-2 py-1">
            <span className="flex-1">
              {connection?.name ?? entry.id}: {entry.state}
              {entry.state === "connected" ? ` (${entry.tools} tools)` : ""}
            </span>
            {entry.state === "failed" && (
              <>
                {connection?.transport === "http" && connection.oauth && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void signInMcp(entry.id)}
                  >
                    Sign in
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void workflowApi(
                      `/api/sessions/${sessionId}/mcp/${entry.id}/retry`,
                      "POST",
                    )
                      .catch((error) => toast.error(String(error)))
                      .finally(() => setBusy(false));
                  }}
                >
                  Retry
                </Button>
              </>
            )}
          </div>
        );
      })}
    </details>
  );
}
