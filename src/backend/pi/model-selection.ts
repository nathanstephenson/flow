import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parsePiModelConfig } from "./model-config.ts";

const legacyAzure = "azure-openai-responses";

export function findPiModel<T extends { provider?: string; id: string }>(available: readonly T[], modelId: string,
  allowBareId = false, agentDir = getAgentDir()): T | undefined {
  const canonicalId = modelId.startsWith(`${legacyAzure}/`) ? `azure/${modelId.slice(legacyAzure.length + 1)}` : modelId;
  if (canonicalId.startsWith("azure/")) {
    for (const name of ["auth.json", "models.json"]) {
      const path = join(agentDir, name);
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf8");
      const data = name === "models.json" ? parsePiModelConfig(content) : JSON.parse(content.replace(/^\uFEFF/, ""));
      const providers = name === "models.json" ? data.providers : data;
      if (providers && Object.hasOwn(providers, legacyAzure) && !Object.hasOwn(providers, "azure")) {
        throw new Error(`Pi 1.6 renamed Provider ${legacyAzure} to azure. Rename its Provider key in ${path} to azure; keep the API name azure-openai-responses unchanged. Flow did not change this file or select another model.`);
      }
    }
  }
  const qualified = available.find((model) => (model.provider ? `${model.provider}/${model.id}` : model.id) === canonicalId);
  if (qualified || !allowBareId || canonicalId.startsWith("azure/")) return qualified;
  const bare = available.filter((model) => model.id === modelId);
  return bare.length === 1 ? bare[0] : undefined;
}

export function piModelUnavailable(modelId: string, label = "Unknown model"): string {
  const azure = modelId.startsWith(`${legacyAzure}/`) || modelId.startsWith("azure/");
  return `${label}: ${modelId}. Select an available model explicitly; no replacement was used.${azure
    ? " Pi 1.6 uses Provider azure. Check the azure Provider keys in Pi auth.json and models.json, and confirm the exact model ID is still available. The API name remains azure-openai-responses."
    : ""}`;
}
