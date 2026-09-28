import { compact, type InlineExtension } from "@earendil-works/pi-coding-agent";

/** Keep Pi's preparation, split-turn handling, file tracking and usage accounting, changing only
 * the model for its summary calls. External extensions remain disabled in Flow's Backend Sessions. */
export function compactionModelExtension(modelId: string, notice: (message: string) => void): InlineExtension {
  return { name: "flow-compaction-model", hidden: true, factory: (pi) => {
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        const model = ctx.modelRegistry.getAvailable().find((candidate) => `${candidate.provider}/${candidate.id}` === modelId);
        if (!model) throw new Error(`Configured compaction model “${modelId}” is unavailable`);
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(auth.error);
        const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
        const headers = Object.fromEntries(Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null));
        const result = await compact(event.preparation, requestModel, auth.apiKey, headers,
          event.customInstructions, event.signal, "off", undefined, auth.env);
        return { compaction: result };
      } catch (error) {
        if (!event.signal.aborted) notice(`Compaction with ${modelId} failed: ${error instanceof Error ? error.message : String(error)}. No other model was used.`);
        // Errors in extension handlers are swallowed by Pi and fall back to its current model.
        // Explicit cancellation instead protects the requested model choice.
        return { cancel: true };
      }
    });
  } };
}
