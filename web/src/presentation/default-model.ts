import type { BackendModels, ModelInfo } from "../../../src/protocol/events.ts";

/**
 * Which model a new Agent Session should start on, before anybody has chosen one.
 *
 * The New Agent Session view offers a model picker, which the dialog it replaced deliberately did
 * not — and this is the function that makes that affordable. The old argument was that a model id is
 * only knowable from a live Backend Session; `GET /api/models` (ADR 0020) removed it, and the reason
 * to *want* the picker is the paste guard: `acceptsImages` is a fact about a `ModelInfo`
 * (ADR 0014), so a page offering Attachments without a chosen model would have to guess, and
 * ADR 0014 is explicit that the composer must treat an unknown model as one that cannot.
 *
 * So this is written to **almost never answer `undefined`**. It returns nothing only while the
 * catalogue is in flight or where the backend could not answer at all — the two cases where the
 * composer is legitimately inert. In particular it does not return nothing merely because nobody has
 * configured a Default Model, which is the state every installation starts in and would otherwise
 * have meant Attachments silently unavailable on this page for most people.
 *
 * DOM-free so `node --test` can hold the fallback order to account, which is where the whole of the
 * behaviour lives.
 */
export function preselectedModel(
  catalogue: BackendModels[] | undefined,
  defaults: Record<string, string> | undefined,
  backend: string,
): ModelInfo | undefined {
  const models = catalogue?.find((entry) => entry.backend === backend)?.models ?? [];
  if (models.length === 0) return undefined;

  /*
   * The configured Default Model wins, but only if the backend can actually reach it. Nothing
   * validates a model id at save time (ADR 0020), so `providers.defaults` may name one that has been
   * withdrawn or was a typo — and preselecting that would put an id in the picker that the list
   * below it does not contain, which reads as a broken control rather than as a stale setting.
   */
  const configured = defaults?.[backend];
  return models.find((model) => model.id === configured) ?? models[0];
}
