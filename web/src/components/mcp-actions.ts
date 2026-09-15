import { useEffect } from "react";
import { workflowApi } from "./workflow-api.ts";
import { toast } from "./ui/toaster.tsx";

export async function signInMcp(id: string) {
  try {
    const result = await workflowApi<{ url: string }>(`/api/mcp/${id}/login`, "POST", {
      returnUrl: window.location.href,
    });
    window.location.assign(result.url);
  } catch (error) {
    toast.error(String(error));
  }
}

export function McpAuthResult() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("mcpAuth");
    if (!result) return;
    url.searchParams.delete("mcpAuth");
    window.history.replaceState(window.history.state, "", url);
    if (result === "signed-in") toast.info("MCP signed in. Existing Agent Sessions can reconnect with Retry.");
    else toast.error("MCP sign-in failed or was refused. Try again.");
  }, []);
  return null;
}
