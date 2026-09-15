import { workflowApi } from "./workflow-api.ts";
import { toast } from "./ui/toaster.tsx";

export async function signInMcp(id: string) {
  try {
    const result = await workflowApi<{ url: string }>(`/api/mcp/${id}/login`, "POST");
    window.location.assign(result.url);
  } catch (error) {
    toast.error(String(error));
  }
}
